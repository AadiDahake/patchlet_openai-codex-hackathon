#!/usr/bin/env node
// Resets the demo: closes the worker's issues and pull requests in the target repository, deletes
// its branches, moves `main` back to the `demo-baseline` tag, starts a Vercel production
// deployment of that commit, and clears escalations, request groups, conversations, known routes
// and trace events. Run through pch-exec so the tokens are in the environment.
//
//   node scripts/reset-demo.mjs [--dry-run] [--skip-main] [--repo owner/name]
//
// The knowledge base is never touched: sources take minutes to read and cost money to embed.
//
// Everything here is the console's Reset demo action, shared through apps/web/lib/demo/reset.ts;
// that file's header holds the rules that keep the forced update of `main` safe. The one thing
// only this script does: when the repository has no `demo-baseline` tag, it creates the tag at
// the current head of `main` (the same as `git tag demo-baseline` followed by
// `git push origin demo-baseline`) and does not move `main`. To pick a new baseline, delete the
// tag on GitHub and run the script again from the commit you want.
//
// `--skip-main` leaves `main`, the tag and the site alone (use it while the target repository is
// still being set up, so the tag is not created at a placeholder commit). `--dry-run` changes
// nothing and reports what a reset would do, including the commit it would deploy.

// Node strips the types on its own. `npm run demo:reset` disables the typeless-package warning
// this raises, because apps/web is a Next app and does not declare "type": "module".
import { BASELINE_TAG, resetDemo } from "../apps/web/lib/demo/reset.ts";

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const skipMain = args.includes("--skip-main");
const repoArg = args.indexOf("--repo");
const REPO = repoArg >= 0 ? args[repoArg + 1] : (process.env.PATCHLET_REPO ?? "AadiDahake/novaair");
const PROJECT_SLUG = process.env.PATCHLET_PROJECT_SLUG ?? "novaair";

const GITHUB_TOKEN = process.env.GITHUB_TOKEN || null;
const VERCEL_TOKEN = process.env.VERCEL_TOKEN || null;
const VERCEL_PROJECT = process.env.TARGET_VERCEL_PROJECT || "novaair";
const SUPABASE_URL = process.env.SUPABASE_URL || null;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || null;

const log = (line) => console.log(`${dryRun ? "[dry-run] " : ""}${line}`);
const short = (sha) => (sha ?? "").slice(0, 7);
const would = (done, planned) => (dryRun ? planned : done);

/** The project whose rows are cleared, looked up by the slug the console manages. */
async function projectId() {
  const response = await fetch(
    `${SUPABASE_URL}/rest/v1/project?slug=eq.${PROJECT_SLUG}&select=id`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } },
  );
  if (!response.ok) throw new Error(`project lookup -> ${response.status}`);
  const rows = await response.json();
  if (rows.length === 0) throw new Error(`no project with slug ${PROJECT_SLUG}`);
  return rows[0].id;
}

/** One line on what happened to `main`. Problems are printed with the rest, as warnings. */
function describeMain(main) {
  switch (main.outcome) {
    case "reset":
      return `${would("moved", "would move")} main from ${short(main.mainSha)} back to ${BASELINE_TAG} (${short(main.baselineSha)}), removing ${main.commitsSinceBaseline} commit(s)`;
    case "at-baseline":
      return `main already at ${BASELINE_TAG} (${short(main.baselineSha)})`;
    case "baseline-created":
      return `tag ${BASELINE_TAG} missing: ${would("created", "would create")} it at main (${short(main.mainSha)}); main is not moved`;
    case "left":
      return "main left alone";
    default:
      return `main not moved (${main.outcome})`;
  }
}

/** One line on what happened to the demo site. */
function describeSite(site, main) {
  const where = site.deployment?.inspectorUrl ?? site.deployment?.url ?? site.deployment?.id ?? "";
  switch (site.outcome) {
    case "deploying":
      return dryRun
        ? `would deploy ${BASELINE_TAG} (${short(main.baselineSha)}) to production of the Vercel project ${site.project}`
        : `deploying ${BASELINE_TAG} (${short(main.baselineSha)}) to production of ${site.project}: ${where}`;
    case "building":
      return `${site.project} is already building ${BASELINE_TAG} for production: ${where}`;
    case "serving":
      return `${site.project} already serves ${BASELINE_TAG} in production`;
    case "skipped":
      return "site not redeployed, because main is not at the baseline";
    default:
      return `site not redeployed (${site.outcome})`;
  }
}

async function main() {
  const summary = await resetDemo({
    repo: REPO,
    githubToken: GITHUB_TOKEN,
    main: skipMain ? "leave" : "reset-or-tag",
    vercelToken: VERCEL_TOKEN,
    vercelProject: VERCEL_PROJECT,
    supabaseUrl: SUPABASE_URL,
    supabaseKey: SUPABASE_KEY,
    projectId: SUPABASE_URL && SUPABASE_KEY ? await projectId() : "",
    dryRun,
  });

  log(`${would("closed", "would close")} ${summary.issuesClosed} issue(s) and ${summary.pullRequestsClosed} pull request(s)`);
  log(`${would("deleted", "would delete")} ${summary.branchesDeleted} branch(es)`);
  log(describeMain(summary.main));
  if (!skipMain) log(describeSite(summary.site, summary.main));
  log(`${would("deleted", "would delete")} ${summary.traceEvents} trace event(s), ${summary.escalations} escalation(s), ${summary.requestGroups} request group(s), ${summary.conversations} conversation(s), ${summary.knownRoutes} known route(s)`);
  for (const problem of summary.problems) console.warn(`warning: ${problem}`);

  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
