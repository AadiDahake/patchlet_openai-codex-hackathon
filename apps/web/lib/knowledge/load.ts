/**
 * Reading one project's knowledge for the picture. Read only: nothing here writes.
 *
 * Every query is scoped to the project id the caller resolved, and the stored vectors never
 * leave this module: the picture gets two numbers per passage and pgvector answers what is near.
 */
import { loadGraph } from "../graph/store";
import { DOCUMENT_COLUMNS, toConsoleDocument } from "../ingest/run";
import { serviceClient } from "../supabase";
import { NEIGHBOURS, layoutByNeighbours } from "./neighbours";
import { projectToPlane } from "./projection";
import { shapeKnowledgeMap, type PassageRow } from "./shape";
import type { KnowledgeMap, NearPassage, VectorLayout } from "./types";
import { parseVector } from "./vector";

/**
 * The most passages one picture holds. A store past this is drawn from its first passages and
 * the view says so; the totals it states are still the whole store. Finding every passage's
 * nearest passages compares each pair once, so the work grows with the square of this number:
 * at 1500 it is about a second.
 */
export const PASSAGE_LIMIT = 1500;

/** How many nearest passages a selected passage shows: the same number the picture ties it to. */
export const NEAR_COUNT = NEIGHBOURS;

/** A vector row is about 20 kB as text, so they are read a few megabytes at a time. */
const VECTOR_PAGE = 200;
const PASSAGE_PAGE = 1000;

/** One order for both readers, so the graph and the vector view draw the same passages. */
const PASSAGE_ORDER = ["document_id", "ordinal", "id"] as const;

type Row = Record<string, unknown>;

/** Reads up to `PASSAGE_LIMIT` chunk rows of a project, a page at a time, in one fixed order. */
async function readPassageRows(projectId: string, columns: string, pageSize: number): Promise<Row[]> {
  const rows: Row[] = [];
  while (rows.length < PASSAGE_LIMIT) {
    const size = Math.min(pageSize, PASSAGE_LIMIT - rows.length);
    let query = serviceClient().from("chunk").select(columns).eq("project_id", projectId);
    for (const column of PASSAGE_ORDER) query = query.order(column);
    const { data, error } = await query.range(rows.length, rows.length + size - 1);
    if (error) throw new Error(`The passages could not be read: ${error.message}`);
    const page = (data ?? []) as unknown as Row[];
    rows.push(...page);
    if (page.length < size) break;
  }
  return rows;
}

function toPassageRow(row: Row): PassageRow {
  return {
    id: String(row.id),
    documentId: String(row.document_id),
    ordinal: Number(row.ordinal ?? 0),
    heading: row.heading == null ? null : String(row.heading),
    content: String(row.content ?? ""),
    page: row.page == null ? null : Number(row.page),
    confidence: row.confidence == null ? null : Number(row.confidence),
    sourceRef: row.source_ref == null ? null : String(row.source_ref),
  };
}

/** Sources, passages, pages, controls and the links between them, for one project. */
export async function loadKnowledgeMap(projectId: string): Promise<KnowledgeMap> {
  const [documents, passages, graph] = await Promise.all([
    serviceClient()
      .from("document")
      .select(DOCUMENT_COLUMNS)
      .eq("project_id", projectId)
      .order("created_at", { ascending: false }),
    readPassageRows(projectId, "id, document_id, ordinal, heading, content, page, confidence, source_ref", PASSAGE_PAGE),
    loadGraph(projectId),
  ]);
  if (documents.error) throw new Error(`The sources could not be read: ${documents.error.message}`);
  return shapeKnowledgeMap({
    documents: ((documents.data ?? []) as Row[]).map(toConsoleDocument),
    passages: passages.map(toPassageRow),
    graph,
  });
}

async function countPassages(projectId: string): Promise<number> {
  const { count, error } = await serviceClient()
    .from("chunk")
    .select("id", { count: "exact", head: true })
    .eq("project_id", projectId);
  if (error) throw new Error(`The passages could not be counted: ${error.message}`);
  return count ?? 0;
}

/**
 * Where each passage lands: on the plane its vectors spread across the most, and from there
 * drawn toward the passages it is nearest to.
 */
export async function loadVectorLayout(projectId: string): Promise<VectorLayout> {
  const [rows, total] = await Promise.all([
    readPassageRows(projectId, "id, embedding", VECTOR_PAGE),
    countPassages(projectId),
  ]);

  const ids: string[] = [];
  const vectors: number[][] = [];
  let dimensions = 0;
  for (const row of rows) {
    const vector = parseVector(row.embedding);
    if (!vector) continue;
    if (dimensions === 0) dimensions = vector.length;
    // A vector of another length is from another model and cannot share a plane with the rest.
    if (vector.length !== dimensions) continue;
    ids.push(String(row.id));
    vectors.push(vector);
  }

  const { points, links, kept } = layoutByNeighbours(vectors, projectToPlane(vectors).points);
  return {
    points: ids.map((id, index) => ({ id, x: points[index]?.[0] ?? 0, y: points[index]?.[1] ?? 0 })),
    links,
    neighbours: NEIGHBOURS,
    dimensions,
    kept,
    total,
  };
}

/**
 * The passages nearest to one passage, by pgvector's cosine distance. Null when the passage is
 * not this project's, which is also the answer for an id that does not exist.
 */
export async function nearestPassages(projectId: string, passageId: string): Promise<NearPassage[] | null> {
  const client = serviceClient();
  const { data: passage, error: readError } = await client
    .from("chunk")
    .select("embedding")
    .eq("project_id", projectId)
    .eq("id", passageId)
    .maybeSingle();
  if (readError) throw new Error(`The passage could not be read: ${readError.message}`);
  if (!passage) return null;

  const { data, error } = await client.rpc("match_chunks", {
    query_embedding: (passage as Row).embedding,
    // The passage is its own nearest neighbour, so one more is asked for and it is dropped.
    match_count: NEAR_COUNT + 1,
    filter_project: projectId,
  });
  if (error) throw new Error(`The nearest passages could not be read: ${error.message}`);

  return ((data ?? []) as Row[])
    .filter((row) => String(row.id) !== passageId)
    .slice(0, NEAR_COUNT)
    .map((row) => ({ id: String(row.id), similarity: Number(row.similarity) }));
}
