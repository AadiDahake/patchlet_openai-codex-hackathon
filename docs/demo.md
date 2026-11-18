# Demo notes

The demo is the NovaAir seat-selection story, start to finish. `docs/PLAN.md` holds it: the
scenario, every fixed number, what each sponsor does at each beat, and the lines to say.

The presenter script lives here. It is being written next.

## Before you start

- Two browser tabs, both already loaded: the host app (NovaAir) and the Patchlet console on
  `/console/activity`. Switching tabs mid-demo is faster than navigating.
- The knowledge base has NovaAir's help documentation ingested. Check `/console/knowledge` shows
  the documents as ready with a chunk count.
- The repository is connected on `/console/repository` and the overview reports the worker online.
- Reset the demo beforehand: Reset demo in the console's account menu, or `npm run demo:reset`.
  Either one puts NovaAir back to its pre-demo state (see "Resetting the demo" below) and clears
  the old escalations. Wait for the site to redeploy, about a minute, before you start.
- Window at 1440x900 or larger. Everything is sized to read on a projector, but the widget panel is
  380 px wide, so do not shrink the window.

## If something goes wrong

- **A check hangs.** The widget shows an elapsed counter rather than a spinner. Keep talking; the
  probes have their own timeouts and the turn completes.
- **The deployment is slow.** The trace stays on `deploying`. Move to questions and come back to the
  reload at the end.
- **You need to run it twice.** Reset demo restores the host app and clears the last escalation,
  so the second run is as clean as the first. Give the site its minute to redeploy.

## Resetting the demo

The console's Reset demo (account menu) and `npm run demo:reset` share one implementation,
`apps/web/lib/demo/reset.ts`. Each one:

1. closes the issues and pull requests the worker opened and deletes its `patchlet/` branches;
2. moves `main` of the bound repository back to the `demo-baseline` tag, which removes every change
   a demo run merged (the confirmation says how many commits that is before you agree);
3. starts a Vercel production deployment of the baseline commit, and does not wait for it: the
   result says the site is redeploying and links the deployment;
4. clears the project's conversations, request groups, escalations, known routes and trace. The
   knowledge base is left alone.

Until 2026-11-18 only the script moved `main`, because a forced update did not seem a job for a
button in a browser. A merged demo change (a light theme) then stayed live on the site through a
console reset, and on 2026-11-18 Aadi asked for the button to put the site back too. A forced
update from a button is safe only under these rules, and the code keeps them for both callers:

- It acts only where Reset demo was already offered: the signed-in account's own project and the
  repository bound to it.
- It needs a `demo-baseline` tag. With no tag, `main` does not move and the result says so. The
  console never creates the tag. The script creates it at the head of `main` on a first run and
  does not move `main` then; to pick a new baseline, delete the tag on GitHub and run the script
  from the commit you want.
- It moves `main` only when the baseline commit is an ancestor of `main`. If it is not, nothing
  moves and the result explains why.
- When GitHub refuses (token permissions, branch protection on `main`) or Vercel refuses, the rest
  of the reset still completes and the result names the problem.

The deployment step comes from the first live run of the script, also on 2026-11-18: `main` moved
from f9d18d3 back to the baseline, Vercel built nothing for the forced update (it had deployed that
commit in August), and production kept serving the merged changes until a deployment was started by
hand. So the reset now asks Vercel for a production build of the baseline commit, with `forceNew`
so the earlier build does not stand in for it, unless production already serves or is already
building that commit. It reads the team and the repository id from the Vercel project
(`TARGET_VERCEL_PROJECT`) and refuses when that project deploys a different repository.

It builds rather than promotes the old deployment of the baseline. Promoting an earlier production
deployment is an Instant Rollback to Vercel, and after one Vercel stops assigning the production
domains to new deployments, so the next demo run's merge would build and never go live. A build
takes about a minute; an Instant Rollback would be instant and would break the next run.

`npm run demo:reset -- --dry-run` prints what a reset would do, including the commit it would
deploy, and changes nothing. `--skip-main` leaves `main`, the tag and the site alone.
