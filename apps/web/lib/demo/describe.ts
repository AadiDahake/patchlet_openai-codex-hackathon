/**
 * What the console says about a demo reset: before it, in the confirmation, and after it, in the
 * account menu. Pure, so the words are tested against every outcome the reset can report.
 */
import type { MainSummary, ResetSummary, SiteSummary } from "@/lib/demo/reset";

/** What a reset would do to `main` and the site, as `GET /api/demo/reset` answers it. */
export type SitePreview = { main: MainSummary; site: SiteSummary };

/** One line of the result. A problem is shown as one; a link names the deployment. */
export type ResultLine = {
  text: string;
  problem: boolean;
  link?: { href: string; label: string };
};

function commits(count: number): string {
  return `${count} commit${count === 1 ? "" : "s"}`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The confirmation's words about the site, once `main` is known to reach the baseline. */
function sitePreview(site: SiteSummary): string | null {
  switch (site.outcome) {
    case "deploying":
      return "Vercel then deploys the baseline. The site is back in about a minute.";
    case "building":
      return "Vercel is already building the baseline.";
    case "serving":
      return "The site already serves the baseline.";
    case "failed":
      return site.problem;
    case "skipped":
      return null;
  }
}

/**
 * What the confirmation says about the demo site's code, one paragraph per entry, so the person
 * knows how many merged commits a reset removes before they agree to it.
 */
export function describeSitePreview(preview: SitePreview): string[] {
  const { main, site } = preview;
  switch (main.outcome) {
    case "reset":
      return [
        `Every change merged into the demo site since the demo-baseline tag is removed. Main goes back to the tag, which takes away ${commits(main.commitsSinceBaseline)}.`,
        sitePreview(site),
      ].filter((line): line is string => Boolean(line));
    case "at-baseline":
    case "baseline-created":
      return [
        "Main is already at the demo-baseline tag, so no commits are removed.",
        site.outcome === "deploying"
          ? "The site still serves a later commit, so Vercel deploys the baseline. The site is back in about a minute."
          : sitePreview(site),
      ].filter((line): line is string => Boolean(line));
    case "left":
    case "no-baseline":
    case "not-ancestor":
    case "failed":
      return main.problem ? [main.problem] : [];
  }
}

/** The result's words about the site, once `main` reached the baseline. */
function siteResult(site: SiteSummary): ResultLine | null {
  const href = site.deployment?.inspectorUrl ?? site.deployment?.url ?? null;
  const link = href ? { href, label: "Follow the deployment on Vercel" } : undefined;
  switch (site.outcome) {
    case "deploying":
      return { text: "The site is redeploying from the baseline and is back in about a minute.", problem: false, link };
    case "building":
      return { text: "Vercel was already building the baseline. The site is back in about a minute.", problem: false, link };
    case "serving":
      return { text: "The site already serves the baseline.", problem: false };
    case "failed":
    case "skipped":
      // A failure is in the summary's problems, which follow.
      return null;
  }
}

/** What the reset did, one line per part, problems last. */
export function describeReset(summary: ResetSummary): ResultLine[] {
  const lines: ResultLine[] = [
    {
      text: `Cleared ${plural(summary.conversations, "conversation")}, ${plural(summary.escalations, "request")}, ${summary.issuesClosed + summary.pullRequestsClosed} closed on GitHub.`,
      problem: false,
    },
  ];

  if (summary.main.outcome === "reset") {
    lines.push({
      text: `Removed the ${commits(summary.main.commitsSinceBaseline)} merged into the demo site since the baseline.`,
      problem: false,
    });
  } else if (summary.main.outcome === "at-baseline") {
    lines.push({ text: "Main was already at the baseline.", problem: false });
  }

  const site = siteResult(summary.site);
  if (site) lines.push(site);

  for (const problem of summary.problems) lines.push({ text: problem, problem: true });
  return lines;
}
