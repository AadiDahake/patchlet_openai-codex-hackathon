/**
 * Reset puts the demo back to its starting position: the rows, the known routes, the worker's
 * issues and pull requests, the demo site's code, and what the product map learned from it.
 *
 * A route the agent remembered answers a question from the last run's product map before a single
 * check runs, so a reset that leaves them behind pins yesterday's answer to today's demo. A change
 * a demo run merged stays on the site unless `main` goes back to the baseline and Vercel serves
 * that commit again, and the console's button does that under the rules in `lib/demo/reset.ts`.
 * The agent keeps pointing at the removed controls until the product map forgets them too.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSiteReset, resetDemo, type ResetOptions } from "@/lib/demo/reset";

type Call = { method: string; url: string; body: unknown };

const REPO = "acme/novaair";
const BASELINE = "b".repeat(40);
const MAIN = "m".repeat(40);
const LATER = "f".repeat(40);

/** The GitHub repository, the Vercel project and the database the fake answers for. */
type World = {
  mainSha: string;
  /** The tag ref's object: a commit, an annotated tag object, or no tag at all. */
  tag: { sha: string; type: "commit" | "tag" } | null;
  /** What an annotated tag object points at. */
  tagObject?: { sha: string; type: string };
  compare: { ahead_by: number; behind_by: number };
  /** The commits the comparison lists, with the committer dates the cutoff is read from. */
  commits: Array<{ sha: string; commit: { committer: { date?: string } } }>;
  /** Status GitHub answers the forced update of main with. */
  updateStatus: number;
  vercelProject: Record<string, unknown>;
  /** Status Vercel answers the new deployment with. */
  deployStatus: number;
  /** Status PostgREST answers a product map table with. */
  mapStatus: number;
};

/** Rows each table holds for the fake, so every count in a summary can be told apart. */
const ROWS: Record<string, number> = { transition: 4, affordance: 11, site_page: 1 };
const EARLIEST = "2026-11-18T08:40:00.000Z";
const MAP_TABLES = ["transition", "affordance", "site_page"];

function world(overrides: Partial<World> = {}): World {
  return {
    mainSha: MAIN,
    tag: { sha: BASELINE, type: "commit" },
    compare: { ahead_by: 3, behind_by: 0 },
    // Out of date order on purpose: the cutoff is the earliest date, not the first commit listed.
    commits: [
      { sha: "c2", commit: { committer: { date: "2026-11-18T08:52:10Z" } } },
      { sha: "c1", commit: { committer: { date: "2026-11-18T08:40:00Z" } } },
      { sha: "c3", commit: { committer: { date: "2026-11-18T08:56:30Z" } } },
    ],
    updateStatus: 200,
    vercelProject: {
      id: "prj_1",
      name: "novaair",
      accountId: "team_1",
      autoAssignCustomDomains: true,
      link: { type: "github", org: "acme", repo: "novaair", repoId: 42, productionBranch: "main" },
      targets: {
        production: {
          id: "dpl_later",
          readyState: "READY",
          readySubstate: "PROMOTED",
          meta: { githubCommitSha: LATER },
        },
      },
    },
    deployStatus: 200,
    mapStatus: 204,
    ...overrides,
  };
}

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** Stands in for GitHub, Vercel and PostgREST, recording every call. */
function fakeFetch(state: World, calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    calls.push({ method, url, body });

    if (url.startsWith("https://api.github.com")) {
      const path = url.replace("https://api.github.com", "");
      if (path === `/repos/${REPO}/git/ref/heads/main`) return json({ object: { sha: state.mainSha, type: "commit" } });
      if (path === `/repos/${REPO}/git/ref/tags/demo-baseline`) {
        return state.tag ? json({ object: state.tag }) : json({ message: "Not Found" }, 404);
      }
      if (path.startsWith(`/repos/${REPO}/git/tags/`)) return json({ object: state.tagObject });
      if (path.startsWith(`/repos/${REPO}/compare/`)) return json({ ...state.compare, commits: state.commits });
      if (path === `/repos/${REPO}/git/refs/heads/main` && method === "PATCH") {
        if (state.updateStatus !== 200) {
          return json({ message: "Cannot force-update a protected branch." }, state.updateStatus);
        }
        return json({ object: { sha: (body as { sha: string }).sha, type: "commit" } });
      }
      if (path === `/repos/${REPO}/git/refs` && method === "POST") return json({ ref: "refs/tags/demo-baseline" }, 201);
      return json([]);
    }

    if (url.startsWith("https://api.vercel.com")) {
      const path = url.replace("https://api.vercel.com", "");
      if (path === "/v9/projects/novaair") return json(state.vercelProject);
      if (path.startsWith("/v13/deployments") && method === "POST") {
        if (state.deployStatus !== 200) {
          return json({ error: { code: "forbidden", message: "Not authorized" } }, state.deployStatus);
        }
        return json({
          id: "dpl_new",
          url: "novaair-new.vercel.app",
          inspectorUrl: "https://vercel.com/acme/novaair/dpl_new",
          readyState: "QUEUED",
        });
      }
      return json({ error: { message: "unexpected" } }, 500);
    }

    const table = new URL(url).pathname.replace("/rest/v1/", "");
    if (MAP_TABLES.includes(table) && state.mapStatus !== 204) {
      return new Response("permission denied", { status: state.mapStatus });
    }
    const status = method === "GET" ? 206 : 204;
    return new Response(null, { status, headers: { "content-range": `*/${ROWS[table] ?? 1}` } });
  }) as unknown as typeof fetch;
}

const DATABASE_ONLY: ResetOptions = {
  repo: null,
  githubToken: null,
  main: "reset",
  vercelToken: null,
  vercelProject: "novaair",
  supabaseUrl: "https://example.supabase.co",
  supabaseKey: "service-role",
  projectId: "project-1",
};

const CONSOLE: ResetOptions = {
  ...DATABASE_ONLY,
  repo: REPO,
  githubToken: "github-token",
  vercelToken: "vercel-token",
};

function run(state: World, options: Partial<ResetOptions> = {}) {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", fakeFetch(state, calls));
  return { calls, summary: resetDemo({ ...CONSOLE, ...options }) };
}

const writes = (calls: Call[]) =>
  calls.filter((call) => call.method !== "GET" && !call.url.startsWith("https://example.supabase.co"));
const mainUpdates = (calls: Call[]) => calls.filter((call) => call.method === "PATCH" && call.url.endsWith("/git/refs/heads/main"));
const deployments = (calls: Call[]) => calls.filter((call) => call.method === "POST" && call.url.includes("/v13/deployments"));
const mapCalls = (calls: Call[]) =>
  calls.filter((call) => MAP_TABLES.some((table) => call.url.startsWith(`https://example.supabase.co/rest/v1/${table}?`)));
const databaseDeletes = (calls: Call[]) =>
  calls.filter((call) => call.method === "DELETE" && !mapCalls([call]).length);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resetDemo: the database", () => {
  it("clears the project's known routes along with its conversations", async () => {
    const { calls, summary: pending } = run(world(), DATABASE_ONLY);
    const summary = await pending;

    const cleared = databaseDeletes(calls).map((call) => call.url.replace("https://example.supabase.co/rest/v1/", ""));
    expect(cleared).toEqual([
      "trace_event?project_id=eq.project-1",
      "escalation?project_id=eq.project-1",
      "feature_request_group?project_id=eq.project-1",
      "conversation?project_id=eq.project-1",
      "known_route?project_id=eq.project-1",
    ]);
    expect(summary.knownRoutes).toBe(1);
    expect(summary.problems).toEqual(["No repository is bound, so the reset does nothing on GitHub or the demo site."]);
    expect(summary.main.outcome).toBe("left");
    expect(summary.site.outcome).toBe("skipped");
  });

  it("leaves the knowledge base alone", async () => {
    const { calls, summary } = run(world(), DATABASE_ONLY);
    await summary;

    expect(calls.some((call) => /\/(document|chunk)\?/.test(call.url))).toBe(false);
  });
});

describe("resetDemo: main and the demo site", () => {
  it("moves main back to the baseline and starts a production deployment of it", async () => {
    const { calls, summary: pending } = run(world());
    const summary = await pending;

    expect(summary.main).toMatchObject({ outcome: "reset", commitsSinceBaseline: 3, baselineSha: BASELINE, mainSha: MAIN });
    expect(mainUpdates(calls)).toHaveLength(1);
    expect(mainUpdates(calls)[0]?.body).toEqual({ sha: BASELINE, force: true });

    const [deploy] = deployments(calls);
    const query = new URL(deploy?.url ?? "").searchParams;
    expect(query.get("forceNew")).toBe("1");
    expect(query.get("teamId")).toBe("team_1");
    expect(deploy?.body).toEqual({
      name: "novaair",
      project: "prj_1",
      target: "production",
      gitSource: { type: "github", repoId: 42, ref: "main", sha: BASELINE },
    });
    expect(summary.site).toEqual({
      outcome: "deploying",
      project: "novaair",
      deployment: {
        id: "dpl_new",
        url: "https://novaair-new.vercel.app/",
        inspectorUrl: "https://vercel.com/acme/novaair/dpl_new",
      },
      problem: null,
    });
    expect(summary.problems).toEqual([]);
  });

  it("reads an annotated tag through its tag object", async () => {
    const { calls, summary: pending } = run(
      world({ tag: { sha: "t".repeat(40), type: "tag" }, tagObject: { sha: BASELINE, type: "commit" } }),
    );
    const summary = await pending;

    expect(summary.main.baselineSha).toBe(BASELINE);
    expect(mainUpdates(calls)[0]?.body).toEqual({ sha: BASELINE, force: true });
  });

  it("changes nothing on main without a baseline tag, never creates one, and says so", async () => {
    const { calls, summary: pending } = run(world({ tag: null }));
    const summary = await pending;

    expect(summary.main.outcome).toBe("no-baseline");
    expect(summary.site.outcome).toBe("skipped");
    expect(writes(calls).filter((call) => call.url.includes("/git/refs"))).toEqual([]);
    expect(deployments(calls)).toEqual([]);
    expect(summary.problems).toContain(
      "acme/novaair has no demo-baseline tag, so main stays where it is. Tag the commit the demo starts from as demo-baseline so a reset can put the site back.",
    );
    expect(databaseDeletes(calls)).toHaveLength(5);
    expect(mapCalls(calls)).toEqual([]);
  });

  it("creates the missing tag at main when the script asks, and does not move main", async () => {
    const { calls, summary: pending } = run(world({ tag: null }), { main: "reset-or-tag" });
    const summary = await pending;

    expect(summary.main).toMatchObject({ outcome: "baseline-created", baselineSha: MAIN });
    const created = calls.find((call) => call.method === "POST" && call.url.endsWith("/git/refs"));
    expect(created?.body).toEqual({ ref: "refs/tags/demo-baseline", sha: MAIN });
    expect(mainUpdates(calls)).toEqual([]);
  });

  it("leaves main alone when it is already at the baseline and production serves it", async () => {
    const state = world({ mainSha: BASELINE });
    state.vercelProject.targets = {
      production: { id: "dpl_base", readyState: "READY", readySubstate: "PROMOTED", meta: { githubCommitSha: BASELINE } },
    };
    const { calls, summary: pending } = run(state);
    const summary = await pending;

    expect(summary.main.outcome).toBe("at-baseline");
    expect(summary.site.outcome).toBe("serving");
    expect(writes(calls)).toEqual([]);
    expect(mapCalls(calls)).toEqual([]);
    expect(summary.problems).toEqual([]);
  });

  it("deploys the baseline when main is back but production still serves a later commit", async () => {
    // The run that found this: main moved, Vercel built nothing, and the merged change stayed live.
    const { calls, summary: pending } = run(world({ mainSha: BASELINE }));
    const summary = await pending;

    expect(summary.main.outcome).toBe("at-baseline");
    expect(mainUpdates(calls)).toEqual([]);
    expect(deployments(calls)).toHaveLength(1);
    expect(summary.site.outcome).toBe("deploying");
  });

  it("starts no second deployment while one of the baseline is building", async () => {
    const state = world();
    state.vercelProject.targets = {
      production: { id: "dpl_building", readyState: "BUILDING", meta: { githubCommitSha: BASELINE } },
    };
    const { calls, summary: pending } = run(state);
    const summary = await pending;

    expect(summary.site).toMatchObject({ outcome: "building", deployment: { id: "dpl_building" } });
    expect(deployments(calls)).toEqual([]);
  });

  it("changes nothing when the baseline is not in the history of main", async () => {
    const { calls, summary: pending } = run(world({ compare: { ahead_by: 2, behind_by: 4 } }));
    const summary = await pending;

    expect(summary.main.outcome).toBe("not-ancestor");
    expect(mainUpdates(calls)).toEqual([]);
    expect(deployments(calls)).toEqual([]);
    expect(mapCalls(calls)).toEqual([]);
    expect(summary.problems).toContain(
      "The demo-baseline commit (bbbbbbb) is not in the history of main (mmmmmmm), so main stays where it is. Move the tag to a commit on main, or put main back by hand.",
    );
  });

  it("finishes the rest of the reset and names the problem when GitHub refuses the update", async () => {
    const { calls, summary: pending } = run(world({ updateStatus: 422 }));
    const summary = await pending;

    expect(summary.main.outcome).toBe("failed");
    expect(summary.main.problem).toBe(
      "GitHub refused to move main back to the demo-baseline tag (422: Cannot force-update a protected branch.), so main stays where it is. The token needs write access to acme/novaair, and branch protection must allow a force push to main.",
    );
    expect(summary.problems).toContain(summary.main.problem);
    expect(summary.site.outcome).toBe("skipped");
    expect(deployments(calls)).toEqual([]);
    expect(mapCalls(calls)).toEqual([]);
    expect(summary.productMap.since).toBeNull();
    expect(databaseDeletes(calls)).toHaveLength(5);
  });

  it("treats a missing repository on the update as a refusal, not a success", async () => {
    const { summary: pending } = run(world({ updateStatus: 404 }));
    const summary = await pending;

    expect(summary.main.outcome).toBe("failed");
    expect(summary.main.problem).toContain("(404: Cannot force-update a protected branch.)");
  });

  it("reports what it would do on a dry run and writes nothing", async () => {
    const { calls, summary: pending } = run(world(), { dryRun: true });
    const summary = await pending;

    expect(calls.every((call) => call.method === "GET")).toBe(true);
    expect(summary.main).toMatchObject({ outcome: "reset", commitsSinceBaseline: 3 });
    expect(summary.site).toMatchObject({ outcome: "deploying", deployment: null });
    expect(summary.productMap).toEqual({ since: EARLIEST, controls: 11, pages: 1, transitions: 4, problem: null });
    expect(mapCalls(calls)).toHaveLength(3);
    expect(summary.knownRoutes).toBe(1);
  });

  it("leaves main and the site alone with --skip-main", async () => {
    const { calls, summary: pending } = run(world(), { main: "leave" });
    const summary = await pending;

    expect(summary.main.outcome).toBe("left");
    expect(summary.site.outcome).toBe("skipped");
    expect(calls.some((call) => call.url.includes("/git/ref/") || call.url.includes("vercel.com"))).toBe(false);
    expect(mapCalls(calls)).toEqual([]);
  });
});

describe("resetDemo: the product map", () => {
  it("forgets every page, control and move first recorded after the earliest removed commit", async () => {
    const { calls, summary: pending } = run(world());
    const summary = await pending;

    const forgotten = mapCalls(calls).map((call) => `${call.method} ${call.url.replace("https://example.supabase.co/rest/v1/", "")}`);
    const since = encodeURIComponent(EARLIEST);
    expect(forgotten).toEqual([
      `DELETE transition?project_id=eq.project-1&first_seen=gt.${since}`,
      `DELETE affordance?project_id=eq.project-1&first_seen=gt.${since}`,
      `DELETE site_page?project_id=eq.project-1&first_seen=gt.${since}`,
    ]);
    expect(summary.main.removedSince).toBe(EARLIEST);
    expect(summary.productMap).toEqual({ since: EARLIEST, controls: 11, pages: 1, transitions: 4, problem: null });
    expect(summary.problems).toEqual([]);
  });

  it("leaves the map alone when main is already at the baseline", async () => {
    const { calls, summary: pending } = run(world({ mainSha: BASELINE }));
    const summary = await pending;

    expect(summary.main.outcome).toBe("at-baseline");
    expect(mapCalls(calls)).toEqual([]);
    expect(summary.productMap.since).toBeNull();
  });

  it("names the problem and finishes the reset when the map cannot be cleared", async () => {
    const { calls, summary: pending } = run(world({ mapStatus: 401 }));
    const summary = await pending;

    expect(summary.main.outcome).toBe("reset");
    expect(summary.productMap.problem).toBe(
      "The product map could not forget the controls of the removed changes (transition answered 401: permission denied). The agent may still point visitors at controls the site no longer has.",
    );
    expect(summary.problems).toContain(summary.productMap.problem);
    expect(databaseDeletes(calls)).toHaveLength(5);
  });

  it("keeps the map and says so when GitHub does not date the removed commits", async () => {
    const { calls, summary: pending } = run(world({ commits: [] }));
    const summary = await pending;

    expect(summary.main.outcome).toBe("reset");
    expect(mapCalls(calls)).toEqual([]);
    expect(summary.productMap.problem).toContain("GitHub did not date the removed commits");
  });
});

describe("resetDemo: Vercel", () => {
  it("says the site is not redeployed when no Vercel token is configured", async () => {
    const { calls, summary: pending } = run(world(), { vercelToken: null });
    const summary = await pending;

    expect(summary.main.outcome).toBe("reset");
    expect(summary.site.outcome).toBe("failed");
    expect(summary.site.problem).toBe(
      "No Vercel token is configured, so the demo site is not redeployed. Until the baseline is deployed, the site keeps serving the changes that main no longer has.",
    );
    expect(summary.problems).toContain(summary.site.problem);
    expect(calls.some((call) => call.url.includes("vercel.com"))).toBe(false);
  });

  it("names Vercel's refusal and claims no deployment", async () => {
    const { summary: pending } = run(world({ deployStatus: 403 }));
    const summary = await pending;

    expect(summary.site.outcome).toBe("failed");
    expect(summary.site.deployment).toBeNull();
    expect(summary.site.problem).toBe(
      "Vercel refused to deploy the demo-baseline commit (bbbbbbb) to novaair (403: Not authorized). Until the baseline is deployed, the site keeps serving the changes that main no longer has.",
    );
  });

  it("does not deploy a Vercel project that serves another repository", async () => {
    const state = world();
    state.vercelProject.link = { type: "github", org: "someone", repo: "else", repoId: 7 };
    const { calls, summary: pending } = run(state);
    const summary = await pending;

    expect(summary.site.outcome).toBe("failed");
    expect(summary.site.problem).toBe("The Vercel project novaair deploys someone/else, not acme/novaair, so it is not redeployed.");
    expect(deployments(calls)).toEqual([]);
  });

  it("does not claim a redeploy when Vercel would stage it instead of serving it", async () => {
    const state = world();
    state.vercelProject.autoAssignCustomDomains = false;
    const { calls, summary: pending } = run(state);
    const summary = await pending;

    expect(summary.site.outcome).toBe("failed");
    expect(summary.site.problem).toContain("Undo the rollback in Vercel");
    expect(deployments(calls)).toEqual([]);
  });
});

describe("checkSiteReset", () => {
  it("counts the commits a reset would remove and writes nothing", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", fakeFetch(world(), calls));

    const preview = await checkSiteReset(CONSOLE);

    expect(preview.main).toMatchObject({ outcome: "reset", commitsSinceBaseline: 3 });
    expect(preview.site.outcome).toBe("deploying");
    expect(preview.productMap.controls).toBe(11);
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });

  it("never creates the baseline tag", async () => {
    const calls: Call[] = [];
    vi.stubGlobal("fetch", fakeFetch(world({ tag: null }), calls));

    const preview = await checkSiteReset(CONSOLE);

    expect(preview.main.outcome).toBe("no-baseline");
    expect(calls.every((call) => call.method === "GET")).toBe(true);
  });
});
