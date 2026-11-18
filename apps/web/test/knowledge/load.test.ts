/**
 * Reading a project's knowledge for the picture, against a database of two projects.
 *
 * Everything here is about one promise: the picture is the signed-in project's and nobody
 * else's, and a stored vector never leaves the server.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

type Row = Record<string, unknown>;

const state = vi.hoisted(() => ({
  tables: {} as Record<string, Record<string, unknown>[]>,
  queries: [] as { table: string; filters: [string, unknown][]; range: [number, number] | null }[],
  rpcs: [] as { name: string; args: Record<string, unknown> }[],
  project: null as { id: string } | null,
}));

function query(table: string) {
  const filters: [string, unknown][] = [];
  const orders: string[] = [];
  let columns: string[] = [];
  let range: [number, number] | null = null;
  let head = false;

  const run = (): { data: Row[] | null; count: number; error: null } => {
    let rows = (state.tables[table] ?? []).filter((row) => filters.every(([column, value]) => row[column] === value));
    rows = [...rows].sort((a, b) => {
      for (const column of orders) {
        if (a[column] === b[column]) continue;
        return (a[column] as string | number) < (b[column] as string | number) ? -1 : 1;
      }
      return 0;
    });
    const count = rows.length;
    if (range) rows = rows.slice(range[0], range[1] + 1);
    state.queries.push({ table, filters, range });
    const picked = rows.map((row) => Object.fromEntries(columns.map((column) => [column, row[column]])));
    return { data: head ? null : picked, count, error: null };
  };

  const builder = {
    select(list: string, options?: { head?: boolean }) {
      columns = list.split(",").map((column) => column.trim());
      head = Boolean(options?.head);
      return builder;
    },
    eq(column: string, value: unknown) {
      filters.push([column, value]);
      return builder;
    },
    order(column: string) {
      orders.push(column);
      return builder;
    },
    range(from: number, to: number) {
      range = [from, to];
      return builder;
    },
    maybeSingle: async () => ({ data: run().data?.[0] ?? null, error: null }),
    then<T>(resolve: (value: ReturnType<typeof run>) => T) {
      return Promise.resolve(run()).then(resolve);
    },
  };
  return builder;
}

vi.mock("@/lib/supabase", () => ({
  serviceClient: () => ({
    from: (table: string) => query(table),
    rpc: async (name: string, args: Record<string, unknown>) => {
      state.rpcs.push({ name, args });
      // What `match_chunks` does: this project's chunks, nearest first, the asker included.
      const rows = (state.tables.chunk ?? [])
        .filter((row) => row.project_id === args.filter_project)
        .map((row, at) => ({ id: row.id, similarity: row.embedding === args.query_embedding ? 1 : 0.9 - at * 0.01 }))
        .sort((a, b) => b.similarity - a.similarity)
        .slice(0, args.match_count as number);
      return { data: rows, error: null };
    },
  }),
}));

vi.mock("@/lib/graph/store", () => ({
  loadGraph: async () => ({ pages: [], controls: [], transitions: [] }),
}));

vi.mock("@/lib/console/current", () => ({
  currentProject: async () => {
    if (!state.project) throw Response.json({ error: "Sign in to use the console." }, { status: 401 });
    return state.project;
  },
  asErrorResponse: (error: unknown) => {
    if (error instanceof Response) return error;
    throw error;
  },
}));

const { NEAR_COUNT, PASSAGE_LIMIT, loadKnowledgeMap, loadVectorLayout, nearestPassages } = await import(
  "@/lib/knowledge/load"
);
const neighbours = await import("@/app/api/knowledge/neighbours/route");
const vectors = await import("@/app/api/knowledge/vectors/route");
const map = await import("@/app/api/knowledge/map/route");

const MINE = "project-mine";
const THEIRS = "project-theirs";
const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** A vector as pgvector hands it over: text. Each one points its own way. */
const stored = (n: number): string => JSON.stringify([Math.cos(n), Math.sin(n), (n % 5) / 5, 1]);

function chunk(n: number, projectId: string, extra: Row = {}): Row {
  return {
    id: uuid(n),
    project_id: projectId,
    document_id: `doc-${projectId}`,
    ordinal: n,
    heading: `Passage ${n}`,
    content: `Text of passage ${n}.`,
    page: null,
    confidence: null,
    source_ref: null,
    embedding: stored(n),
    ...extra,
  };
}

function document(projectId: string, title: string, chunkCount: number): Row {
  return {
    id: `doc-${projectId}`,
    project_id: projectId,
    title,
    source_kind: "text",
    source_ref: null,
    mime: null,
    status: "ready",
    page_count: null,
    mean_confidence: null,
    chunk_count: chunkCount,
    error: null,
    created_at: "2026-08-30T00:00:00Z",
    storage_path: null,
  };
}

beforeEach(() => {
  state.queries.length = 0;
  state.rpcs.length = 0;
  state.project = { id: MINE };
  state.tables = {
    document: [document(MINE, "Mine", 12), document(THEIRS, "Theirs", 3)],
    chunk: [
      ...Array.from({ length: 12 }, (_, n) => chunk(n + 1, MINE)),
      ...Array.from({ length: 3 }, (_, n) => chunk(n + 101, THEIRS)),
    ],
  };
});

describe("loadKnowledgeMap", () => {
  it("draws the project's own sources and passages and nobody else's", async () => {
    const result = await loadKnowledgeMap(MINE);
    expect(result.sources.map((source) => source.title)).toEqual(["Mine"]);
    expect(result.passages).toHaveLength(12);
    expect(result.passages.every((passage) => passage.sourceId === `doc-${MINE}`)).toBe(true);
    expect(result.totals.passages).toBe(12);
  });

  it("scopes every query to the project and never reads a vector", async () => {
    await loadKnowledgeMap(MINE);
    expect(state.queries.length).toBeGreaterThan(0);
    for (const read of state.queries) expect(read.filters).toContainEqual(["project_id", MINE]);
    expect(JSON.stringify(await loadKnowledgeMap(MINE))).not.toMatch(/embedding|0\.5403/);
  });
});

describe("loadVectorLayout", () => {
  it("places the project's passages and sends two numbers each, never the vector", async () => {
    const layout = await loadVectorLayout(MINE);
    expect(layout.points.map((point) => point.id)).toEqual(Array.from({ length: 12 }, (_, n) => uuid(n + 1)));
    expect(layout.points.every((point) => Object.keys(point).join() === "id,x,y")).toBe(true);
    expect(layout).toMatchObject({ dimensions: 4, total: 12, neighbours: NEAR_COUNT });
    expect(layout.kept).toBeGreaterThan(0);
    expect(layout.links.every(([a, b]) => a < b && b < 12)).toBe(true);
    for (const read of state.queries) expect(read.filters).toContainEqual(["project_id", MINE]);
  });

  it("gives the same picture twice", async () => {
    expect(await loadVectorLayout(MINE)).toEqual(await loadVectorLayout(MINE));
  });

  it("reads a large store a page at a time, each passage once, and stops at the limit", async () => {
    state.tables.chunk = Array.from({ length: PASSAGE_LIMIT + 40 }, (_, n) => chunk(n + 1, MINE));
    const layout = await loadVectorLayout(MINE);
    const pages = state.queries.filter((read) => read.range !== null).map((read) => read.range);
    expect(pages.length).toBeGreaterThan(1);
    expect(pages[0]?.[0]).toBe(0);
    pages.slice(1).forEach((page, at) => expect(page?.[0]).toBe((pages[at]?.[1] ?? 0) + 1));
    expect(pages.at(-1)?.[1]).toBe(PASSAGE_LIMIT - 1);
    expect(new Set(layout.points.map((point) => point.id)).size).toBe(PASSAGE_LIMIT);
    // The total is still the whole store, so the view can say that it drew a part.
    expect(layout.total).toBe(PASSAGE_LIMIT + 40);
  });

  it("leaves out a vector that does not parse or is from another model", async () => {
    state.tables.chunk = [
      chunk(1, MINE),
      chunk(2, MINE, { embedding: "not a vector" }),
      chunk(3, MINE, { embedding: "[1,2]" }),
      chunk(4, MINE),
      chunk(5, MINE),
    ];
    const layout = await loadVectorLayout(MINE);
    expect(layout.points.map((point) => point.id)).toEqual([uuid(1), uuid(4), uuid(5)]);
    expect(layout.total).toBe(5);
  });

  it("has nothing to place for a project with no passages", async () => {
    state.tables.chunk = [];
    expect(await loadVectorLayout(MINE)).toEqual({
      points: [],
      links: [],
      neighbours: NEAR_COUNT,
      dimensions: 0,
      kept: 1,
      total: 0,
    });
  });
});

describe("nearestPassages", () => {
  it("asks pgvector with the passage's own stored vector, inside the project", async () => {
    const near = await nearestPassages(MINE, uuid(3));
    expect(state.rpcs).toEqual([
      { name: "match_chunks", args: { query_embedding: stored(3), match_count: NEAR_COUNT + 1, filter_project: MINE } },
    ]);
    expect(near).toHaveLength(NEAR_COUNT);
    expect(near?.some((entry) => entry.id === uuid(3))).toBe(false);
    expect(near?.every((entry, at) => at === 0 || entry.similarity <= (near[at - 1]?.similarity ?? 1))).toBe(true);
  });

  it("refuses a passage of another project, and asks pgvector nothing", async () => {
    expect(await nearestPassages(MINE, uuid(101))).toBeNull();
    expect(await nearestPassages(MINE, uuid(999))).toBeNull();
    expect(state.rpcs).toEqual([]);
  });

  it("returns what there is when the store is smaller than the count", async () => {
    state.tables.chunk = [chunk(1, MINE), chunk(2, MINE)];
    expect((await nearestPassages(MINE, uuid(1)))?.map((entry) => entry.id)).toEqual([uuid(2)]);
  });
});

describe("the three routes", () => {
  const ask = (passage: string): Promise<Response> =>
    neighbours.GET(new Request(`http://localhost/api/knowledge/neighbours?passage=${passage}`));

  it("answer 401 without a session and read nothing", async () => {
    state.project = null;
    for (const response of [await map.GET(), await vectors.GET(), await ask(uuid(1))]) expect(response.status).toBe(401);
    expect(state.queries).toEqual([]);
    expect(state.rpcs).toEqual([]);
  });

  it("answer for the signed-in project", async () => {
    expect(((await (await map.GET()).json()) as { map: { totals: { sources: number } } }).map.totals.sources).toBe(1);
    expect(((await (await vectors.GET()).json()) as { layout: { points: unknown[] } }).layout.points).toHaveLength(12);
    expect(((await (await ask(uuid(1))).json()) as { near: unknown[] }).near).toHaveLength(NEAR_COUNT);
  });

  it("refuse an id that is not a passage id before it reaches the database", async () => {
    for (const bad of ["", "1", "abc", `${uuid(1)}'; drop table chunk; --`, "../../etc/passwd"]) {
      expect((await ask(encodeURIComponent(bad))).status).toBe(400);
    }
    expect(state.queries).toEqual([]);
  });

  it("answer 404 for a passage that belongs to another project", async () => {
    expect((await ask(uuid(101))).status).toBe(404);
    expect(state.rpcs).toEqual([]);
  });
});
