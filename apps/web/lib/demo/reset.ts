/**
 * Putting the demo back to its starting position.
 *
 * Two callers share this: the console's Reset demo action and `scripts/reset-demo.mjs`. It has no
 * imports on purpose, so the script can load it directly and so nothing here can reach for a
 * server-only client by accident.
 *
 * It deliberately leaves the knowledge base alone. Sources take minutes to read and cost money to
 * embed; the demo starts from a repository with nothing filed against it, not from an empty index.
 *
 * It also puts the demo site's code back. A demo run ends with a merged change live on the site,
 * so the reset moves the target repository's `main` back to the `demo-baseline` tag and has Vercel
 * serve that commit again. Until 2026-11-18 only the script moved `main`, on the view that a forced
 * update is not a job for a button in a browser. Aadi asked that day for the button to do it too,
 * because a change a demo run merged (a light theme, that time) stayed on the site after a reset.
 * A forced update from a button is safe only under these rules, and both callers keep them:
 *
 * - It runs only where Reset demo is already offered: the caller's own project and the repository
 *   bound to it. Nothing here widens that.
 * - It needs a `demo-baseline` tag. Without one, `main` stays where it is and the summary says so.
 *   The console never creates the tag; only the script does, at the head of `main`, on a first run.
 * - It moves `main` only when the baseline commit is in the history of `main`, so a reset can only
 *   take away commits made after the baseline.
 * - When GitHub or Vercel refuses (permissions, branch protection), the rest of the reset still
 *   runs and the summary names the problem in words a person can act on.
 *
 * Moving `main` is not enough on its own. On 2026-11-18 Vercel built no deployment for the forced
 * update (it had deployed the baseline commit before) and production kept serving the removed
 * changes. So the reset starts a production deployment of the baseline itself, unless production
 * already serves it or is already building it. It builds a new deployment rather than promoting
 * the old one: promoting an earlier production deployment is an Instant Rollback to Vercel, which
 * turns off the automatic domain assignment, and the next demo run's merge would never go live.
 * The reset does not wait for the build; it says the site is redeploying and names the deployment.
 */

/**
 * What a reset does with the repository's `main` branch.
 *
 * `reset` moves it back to the baseline tag when the rules above allow it and never creates the
 * tag; the console uses it. `reset-or-tag` also creates the tag at the head of `main` when it is
 * missing, which only the script does. `leave` touches neither `main` nor the site.
 */
export type MainMode = "reset" | "reset-or-tag" | "leave";

/**
 * What happened to `main`, or on a dry run what would happen.
 *
 * `left`: the caller asked to leave it, or there is no repository or credential.
 * `no-baseline`: the repository has no baseline tag. `baseline-created`: the script created the
 * tag at the head of `main`. `at-baseline`: `main` already points at the baseline. `reset`: `main`
 * moved back to the baseline. `not-ancestor`: the baseline is not in the history of `main`.
 * `failed`: GitHub could not be read or refused the update. Only `reset` changes `main`.
 */
export type MainOutcome =
  | "left"
  | "no-baseline"
  | "baseline-created"
  | "at-baseline"
  | "reset"
  | "not-ancestor"
  | "failed";

export type MainSummary = {
  outcome: MainOutcome;
  /** Commits on `main` after the baseline when it was read: the commits a reset takes away. */
  commitsSinceBaseline: number;
  baselineSha: string | null;
  mainSha: string | null;
  /** Why `main` did not reach the baseline, in words a person can act on. */
  problem: string | null;
};

/**
 * What happened to the demo site once `main` was at the baseline.
 *
 * `skipped`: `main` is not at the baseline, so there is nothing to deploy. `serving`: production
 * already serves the baseline. `building`: a production deployment of the baseline was already
 * under way. `deploying`: this reset started one (on a dry run: would start one). `failed`: no
 * token, a project linked to another repository, or Vercel refused.
 */
export type SiteOutcome = "skipped" | "serving" | "building" | "deploying" | "failed";

export type SiteDeployment = {
  id: string;
  /** The deployment's own address. */
  url: string | null;
  /** The deployment's page in the Vercel dashboard, where its build can be followed. */
  inspectorUrl: string | null;
};

export type SiteSummary = {
  outcome: SiteOutcome;
  /** The Vercel project that serves the demo site. */
  project: string | null;
  /** The deployment this reset started, or the one already serving or building the baseline. */
  deployment: SiteDeployment | null;
  /** Why the site was not put back, in words a person can act on. */
  problem: string | null;
};

/** What the site half of a reset needs: where the code lives and where it is served from. */
export type SiteResetOptions = {
  /** `owner/name` of the repository the worker files against. Skipped when null. */
  repo: string | null;
  githubToken: string | null;
  vercelToken: string | null;
  /** The Vercel project that serves the demo site from the repository's `main`. */
  vercelProject: string | null;
};

export type ResetOptions = SiteResetOptions & {
  /** What happens to the repository's `main` branch and the site it deploys. */
  main: MainMode;
  supabaseUrl: string | null;
  supabaseKey: string | null;
  /** Only this project's conversations, requests, escalations, known routes and trace events are cleared. */
  projectId: string;
  /** Report what would happen and change nothing. */
  dryRun?: boolean;
};

export type ResetSummary = {
  dryRun: boolean;
  repo: string | null;
  issuesClosed: number;
  pullRequestsClosed: number;
  branchesDeleted: number;
  main: MainSummary;
  site: SiteSummary;
  traceEvents: number;
  escalations: number;
  requestGroups: number;
  conversations: number;
  /** Questions the agent had already resolved to a control, which would otherwise pin an answer. */
  knownRoutes: number;
  /** Anything that could not be done, in words a person can act on. */
  problems: string[];
};

/** The tag that marks the commit `main` is reset to. */
export const BASELINE_TAG = "demo-baseline";
const MAIN_BRANCH = "main";
/** The label the worker puts on the issues it files. */
const ISSUE_LABEL = "patchlet";
/** Every branch the worker pushes starts with this. */
const BRANCH_PREFIX = "patchlet/";
/** Vercel's states for a deployment that has not finished building. */
const BUILDING_STATES = new Set(["QUEUED", "INITIALIZING", "BUILDING"]);

type Json = Record<string, unknown>;

/** A non-success answer from GitHub or Vercel, kept with its status so a refusal can be named. */
class ServiceError extends Error {
  status: number;
  /** The service's own explanation, when its answer carried one. */
  said: string;

  constructor(method: string, path: string, status: number, body: string) {
    const said = explanation(body);
    super(`${method} ${path} answered ${status}${said ? `: ${said}` : ""}`);
    this.name = "ServiceError";
    this.status = status;
    this.said = said;
  }
}

/** GitHub explains itself in `{message}` and Vercel in `{error: {message}}`. */
function explanation(body: string): string {
  try {
    const parsed = asRecord(JSON.parse(body));
    const message = parsed?.message ?? asRecord(parsed?.error)?.message;
    if (typeof message === "string" && message) return message.slice(0, 200);
  } catch {
    // Not JSON: the raw text is the explanation.
  }
  return body.trim().slice(0, 200);
}

/**
 * One GitHub call. A missing resource answers null on a read, because "no such tag" is an answer;
 * on a write it throws, because a write that found nothing did not happen.
 */
async function github(token: string, method: string, path: string, body?: Json): Promise<unknown> {
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (response.status === 204) return null;
  if (response.status === 404 && method === "GET") return null;
  if (!response.ok) {
    throw new ServiceError(method, path, response.status, await response.text().catch(() => ""));
  }
  return response.json();
}

async function vercel(token: string, method: string, path: string, body?: Json): Promise<unknown> {
  const response = await fetch(`https://api.vercel.com${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!response.ok) {
    throw new ServiceError(method, path, response.status, await response.text().catch(() => ""));
  }
  return response.json();
}

function asRecord(value: unknown): Json | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Json) : null;
}

function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

function text(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

function short(sha: string): string {
  return sha.slice(0, 7);
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A service's refusal in a person's terms: the status and what the service said, not the URL. */
function refusal(error: unknown): string {
  if (error instanceof ServiceError) return `${error.status}${error.said ? `: ${error.said}` : ""}`;
  return reason(error);
}

/** Closes the issues the worker filed, leaving anything a person opened alone. */
async function closeIssues(token: string, repo: string, dryRun: boolean): Promise<number> {
  const issues = asArray(
    await github(token, "GET", `/repos/${repo}/issues?state=open&labels=${ISSUE_LABEL}&per_page=100`),
  ).filter((issue) => !issue.pull_request);

  for (const issue of issues) {
    if (!dryRun) {
      await github(token, "PATCH", `/repos/${repo}/issues/${issue.number as number}`, {
        state: "closed",
        state_reason: "not_planned",
      });
    }
  }
  return issues.length;
}

/** Closes the pull requests the worker opened, recognised by their branch. */
async function closePullRequests(token: string, repo: string, dryRun: boolean): Promise<number> {
  const pulls = asArray(await github(token, "GET", `/repos/${repo}/pulls?state=open&per_page=100`)).filter(
    (pull) => String((pull.head as Json | undefined)?.ref ?? "").startsWith(BRANCH_PREFIX),
  );

  for (const pull of pulls) {
    if (!dryRun) {
      await github(token, "PATCH", `/repos/${repo}/pulls/${pull.number as number}`, { state: "closed" });
    }
  }
  return pulls.length;
}

async function deleteBranches(token: string, repo: string, dryRun: boolean): Promise<number> {
  const refs = asArray(
    await github(token, "GET", `/repos/${repo}/git/matching-refs/heads/${BRANCH_PREFIX}`),
  );

  for (const ref of refs) {
    const name = String(ref.ref).replace("refs/heads/", "");
    if (!dryRun) await github(token, "DELETE", `/repos/${repo}/git/refs/heads/${name}`);
  }
  return refs.length;
}

/** What a git ref or tag object points at, and what kind of object that is. */
function pointee(value: unknown): { sha: string; type: string } | null {
  const object = asRecord(asRecord(value)?.object);
  const sha = text(object?.sha);
  const type = text(object?.type);
  return sha && type ? { sha, type } : null;
}

/** The commit the baseline tag names, or null when the repository has no such tag. */
async function baselineCommit(token: string, repo: string): Promise<string | null> {
  const ref = pointee(await github(token, "GET", `/repos/${repo}/git/ref/tags/${BASELINE_TAG}`));
  if (!ref) return null;
  // A lightweight tag points at the commit; an annotated tag points at a tag object first.
  const target =
    ref.type === "tag" ? pointee(await github(token, "GET", `/repos/${repo}/git/tags/${ref.sha}`)) : ref;
  if (target?.type !== "commit") throw new Error(`the ${BASELINE_TAG} tag does not point at a commit`);
  return target.sha;
}

/** Commits only `head` has (ahead) and commits only `base` has (behind). */
async function distance(
  token: string,
  repo: string,
  base: string,
  head: string,
): Promise<{ ahead: number; behind: number }> {
  const answer = asRecord(await github(token, "GET", `/repos/${repo}/compare/${base}...${head}?per_page=1`));
  const ahead = answer?.ahead_by;
  const behind = answer?.behind_by;
  if (typeof ahead !== "number" || typeof behind !== "number") {
    throw new Error(`GitHub did not compare ${short(base)} with ${short(head)}`);
  }
  return { ahead, behind };
}

function mainSummary(outcome: MainOutcome, problem: string | null = null): MainSummary {
  return { outcome, commitsSinceBaseline: 0, baselineSha: null, mainSha: null, problem };
}

/** Moves `main` back to the baseline tag when the rules in the header allow it. */
async function resetMain(
  token: string,
  repo: string,
  mode: Exclude<MainMode, "leave">,
  dryRun: boolean,
): Promise<MainSummary> {
  const stays = `so ${MAIN_BRANCH} stays where it is`;
  const summary = mainSummary("failed");

  let baseline: string | null;
  try {
    summary.mainSha = pointee(await github(token, "GET", `/repos/${repo}/git/ref/heads/${MAIN_BRANCH}`))?.sha ?? null;
    if (!summary.mainSha) {
      return { ...summary, problem: `GitHub shows this token no ${MAIN_BRANCH} branch in ${repo}, ${stays}.` };
    }
    baseline = await baselineCommit(token, repo);
  } catch (error) {
    return { ...summary, problem: `GitHub could not be read (${refusal(error)}), ${stays}.` };
  }
  const head = summary.mainSha;

  if (!baseline) {
    if (mode === "reset") {
      return {
        ...summary,
        outcome: "no-baseline",
        problem: `${repo} has no ${BASELINE_TAG} tag, ${stays}. Tag the commit the demo starts from as ${BASELINE_TAG} so a reset can put the site back.`,
      };
    }
    try {
      if (!dryRun) {
        await github(token, "POST", `/repos/${repo}/git/refs`, { ref: `refs/tags/${BASELINE_TAG}`, sha: head });
      }
    } catch (error) {
      return { ...summary, problem: `GitHub refused to create the ${BASELINE_TAG} tag (${refusal(error)}).` };
    }
    return { ...summary, outcome: "baseline-created", baselineSha: head };
  }

  summary.baselineSha = baseline;
  if (baseline === head) return { ...summary, outcome: "at-baseline" };

  let gap: { ahead: number; behind: number };
  try {
    gap = await distance(token, repo, baseline, head);
  } catch (error) {
    return {
      ...summary,
      problem: `GitHub could not compare ${MAIN_BRANCH} with the ${BASELINE_TAG} tag (${refusal(error)}), ${stays}.`,
    };
  }
  if (gap.behind > 0) {
    return {
      ...summary,
      outcome: "not-ancestor",
      problem: `The ${BASELINE_TAG} commit (${short(baseline)}) is not in the history of ${MAIN_BRANCH} (${short(head)}), ${stays}. Move the tag to a commit on ${MAIN_BRANCH}, or put ${MAIN_BRANCH} back by hand.`,
    };
  }
  summary.commitsSinceBaseline = gap.ahead;
  if (dryRun) return { ...summary, outcome: "reset" };

  // The REST API has no compare-and-swap for a ref. A commit merged in the instant between the
  // check above and this update is also after the baseline, so it goes with the rest.
  try {
    const moved = pointee(
      await github(token, "PATCH", `/repos/${repo}/git/refs/heads/${MAIN_BRANCH}`, { sha: baseline, force: true }),
    );
    if (moved?.sha !== baseline) throw new Error(`GitHub did not report ${MAIN_BRANCH} at ${short(baseline)}`);
  } catch (error) {
    return {
      ...summary,
      problem: `GitHub refused to move ${MAIN_BRANCH} back to the ${BASELINE_TAG} tag (${refusal(error)}), ${stays}. The token needs write access to ${repo}, and branch protection must allow a force push to ${MAIN_BRANCH}.`,
    };
  }
  return { ...summary, outcome: "reset" };
}

type VercelProject = {
  id: string;
  name: string;
  /** Set when a team owns the project; every write names it. */
  teamId: string | null;
  /** `owner/name` of the GitHub repository the project deploys, when it is linked to one. */
  repo: string | null;
  repoId: string | number | null;
  /** False after an Instant Rollback: a new production deployment then does not go live. */
  autoAssign: boolean;
  /** The project's latest production deployment. */
  production: VercelDeployment | null;
};

type VercelDeployment = SiteDeployment & {
  sha: string | null;
  state: string;
  /** Built for production but not serving it. */
  staged: boolean;
};

/** An address the console may link to: https only, whatever the answer held. */
function httpsUrl(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  try {
    const url = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function readDeployment(value: unknown): VercelDeployment | null {
  const deployment = asRecord(value);
  const id = text(deployment?.id) ?? text(deployment?.uid);
  if (!deployment || !id) return null;
  return {
    id,
    url: httpsUrl(deployment.url),
    inspectorUrl: httpsUrl(deployment.inspectorUrl),
    sha: text(asRecord(deployment.meta)?.githubCommitSha),
    state: text(deployment.readyState) ?? text(deployment.state) ?? "",
    staged: deployment.readySubstate === "STAGED",
  };
}

function readProject(value: unknown): VercelProject {
  const project = asRecord(value);
  const id = text(project?.id);
  if (!project || !id) throw new Error("Vercel answered without a project");
  const link = asRecord(project.link);
  const org = text(link?.org);
  const name = text(link?.repo);
  const repoId = typeof link?.repoId === "number" || typeof link?.repoId === "string" ? link.repoId : null;
  const accountId = text(project.accountId);
  return {
    id,
    name: text(project.name) ?? id,
    teamId: accountId?.startsWith("team_") ? accountId : null,
    repo: link?.type === "github" && org && name && repoId !== null ? `${org}/${name}` : null,
    repoId,
    autoAssign: project.autoAssignCustomDomains !== false,
    production: readDeployment(asRecord(project.targets)?.production),
  };
}

function siteSummary(
  outcome: SiteOutcome,
  project: string | null,
  deployment: VercelDeployment | null = null,
  problem: string | null = null,
): SiteSummary {
  const shown = deployment
    ? { id: deployment.id, url: deployment.url, inspectorUrl: deployment.inspectorUrl }
    : null;
  return { outcome, project, deployment: shown, problem };
}

/** Makes Vercel serve the baseline commit, once `main` is back at it. */
async function deploySite(
  token: string | null,
  projectName: string | null,
  repo: string,
  baseline: string,
  dryRun: boolean,
): Promise<SiteSummary> {
  const failed = (problem: string): SiteSummary => siteSummary("failed", projectName, null, problem);
  const stale = "Until the baseline is deployed, the site keeps serving the changes that main no longer has.";
  if (!projectName) return failed(`No Vercel project is named for the demo site, so it is not redeployed. ${stale}`);
  if (!token) return failed(`No Vercel token is configured, so the demo site is not redeployed. ${stale}`);

  let project: VercelProject;
  try {
    project = readProject(await vercel(token, "GET", `/v9/projects/${encodeURIComponent(projectName)}`));
  } catch (error) {
    return failed(`Vercel could not be read for the project ${projectName} (${refusal(error)}). ${stale}`);
  }
  if (project.repo?.toLowerCase() !== repo.toLowerCase()) {
    return failed(
      `The Vercel project ${projectName} deploys ${project.repo ?? "no GitHub repository"}, not ${repo}, so it is not redeployed.`,
    );
  }
  if (!project.autoAssign) {
    return failed(
      `Vercel does not put new production deployments of ${projectName} live on its own (automatic domain assignment is off, as after an Instant Rollback). Undo the rollback in Vercel, then reset the demo again.`,
    );
  }

  const production = project.production;
  if (production?.sha === baseline) {
    if (production.state === "READY" && !production.staged) return siteSummary("serving", projectName, production);
    if (BUILDING_STATES.has(production.state)) return siteSummary("building", projectName, production);
  }
  if (dryRun) return siteSummary("deploying", projectName);

  // `forceNew` because Vercel deduplicates a commit it has built before, which is exactly the
  // baseline's case; the sha pins the build to the baseline even if `main` moves again meanwhile.
  const query = new URLSearchParams({ forceNew: "1", ...(project.teamId ? { teamId: project.teamId } : {}) });
  try {
    const created = readDeployment(
      await vercel(token, "POST", `/v13/deployments?${query.toString()}`, {
        name: project.name,
        project: project.id,
        target: "production",
        gitSource: { type: "github", repoId: project.repoId, ref: MAIN_BRANCH, sha: baseline },
      }),
    );
    if (!created) throw new Error("Vercel answered without a deployment");
    return siteSummary("deploying", projectName, created);
  } catch (error) {
    return failed(
      `Vercel refused to deploy the ${BASELINE_TAG} commit (${short(baseline)}) to ${projectName} (${refusal(error)}). ${stale}`,
    );
  }
}

/** Why nothing on GitHub can be done, or null when there is a repository and a credential. */
function githubUnavailable(repo: string | null, githubToken: string | null): string | null {
  // Present tense, because the confirmation shows it before anything happens.
  if (!repo) return "No repository is bound, so the reset does nothing on GitHub or the demo site.";
  if (!githubToken) return "No GitHub credential is configured, so the reset does nothing on GitHub or the demo site.";
  return null;
}

async function resetSite(
  options: SiteResetOptions,
  mode: MainMode,
  dryRun: boolean,
): Promise<{ main: MainSummary; site: SiteSummary }> {
  const skipped = siteSummary("skipped", options.vercelProject);
  if (mode === "leave") return { main: mainSummary("left"), site: skipped };
  const { repo, githubToken } = options;
  if (!repo || !githubToken) return { main: mainSummary("left", githubUnavailable(repo, githubToken)), site: skipped };

  const main = await resetMain(githubToken, repo, mode, dryRun);
  const atBaseline = main.outcome === "reset" || main.outcome === "at-baseline" || main.outcome === "baseline-created";
  if (!atBaseline || !main.baselineSha) return { main, site: skipped };
  const site = await deploySite(options.vercelToken, options.vercelProject, repo, main.baselineSha, dryRun);
  return { main, site };
}

/**
 * What a reset would do to `main` and the demo site, changing nothing. The console shows it in the
 * confirmation, so the person knows how many commits go before they agree.
 */
export function checkSiteReset(options: SiteResetOptions): Promise<{ main: MainSummary; site: SiteSummary }> {
  return resetSite(options, "reset", true);
}

/** Deletes rows through PostgREST and returns how many went, counted by the server. */
async function clearTable(
  url: string,
  key: string,
  table: string,
  filter: string,
  dryRun: boolean,
): Promise<number> {
  const response = await fetch(`${url}/rest/v1/${table}?${filter}`, {
    method: dryRun ? "GET" : "DELETE",
    headers: {
      apikey: key,
      authorization: `Bearer ${key}`,
      prefer: "count=exact",
      ...(dryRun ? { range: "0-0" } : {}),
    },
  });
  if (!response.ok && response.status !== 206) {
    const detail = await response.text().catch(() => "");
    throw new Error(`${table} answered ${response.status}: ${detail.slice(0, 200)}`);
  }
  const range = response.headers.get("content-range") ?? "";
  return Number(range.split("/")[1] ?? 0);
}

/**
 * Closes what the worker opened, deletes its branches, puts `main` and the demo site back to the
 * baseline, and clears the conversations, request groups, escalations, known routes and trace
 * events of one project. A step that fails is recorded and the rest still runs, because a
 * half-reset demo is worse than one that says which half is left.
 */
export async function resetDemo(options: ResetOptions): Promise<ResetSummary> {
  const dryRun = options.dryRun ?? false;
  const summary: ResetSummary = {
    dryRun,
    repo: options.repo,
    issuesClosed: 0,
    pullRequestsClosed: 0,
    branchesDeleted: 0,
    main: mainSummary("left"),
    site: siteSummary("skipped", options.vercelProject),
    traceEvents: 0,
    escalations: 0,
    requestGroups: 0,
    conversations: 0,
    knownRoutes: 0,
    problems: [],
  };
  const note = (problem: string | null): void => {
    if (problem && !summary.problems.includes(problem)) summary.problems.push(problem);
  };

  const { repo, githubToken } = options;
  if (repo && githubToken) {
    for (const [name, step] of [
      ["issuesClosed", () => closeIssues(githubToken, repo, dryRun)],
      ["pullRequestsClosed", () => closePullRequests(githubToken, repo, dryRun)],
      ["branchesDeleted", () => deleteBranches(githubToken, repo, dryRun)],
    ] as const) {
      try {
        summary[name] = await step();
      } catch (error) {
        note(reason(error));
      }
    }
  } else {
    note(githubUnavailable(repo, githubToken));
  }

  const { main, site } = await resetSite(options, options.main, dryRun);
  summary.main = main;
  summary.site = site;
  note(main.problem);
  note(site.problem);

  const { supabaseUrl, supabaseKey, projectId } = options;
  if (supabaseUrl && supabaseKey) {
    // Trace events first: they point at the escalations and conversations that follow. Request
    // groups have to go too, or the next demo joins the group this one left behind and files
    // nothing. Known routes go with them: a route the agent remembered answers the demo's first
    // question from the last run's product map, before a single check runs.
    for (const [name, table] of [
      ["traceEvents", "trace_event"],
      ["escalations", "escalation"],
      ["requestGroups", "feature_request_group"],
      ["conversations", "conversation"],
      ["knownRoutes", "known_route"],
    ] as const) {
      try {
        summary[name] = await clearTable(
          supabaseUrl,
          supabaseKey,
          table,
          `project_id=eq.${projectId}`,
          dryRun,
        );
      } catch (error) {
        note(reason(error));
      }
    }
  } else {
    note("No database credential is configured, so nothing was cleared.");
  }

  return summary;
}
