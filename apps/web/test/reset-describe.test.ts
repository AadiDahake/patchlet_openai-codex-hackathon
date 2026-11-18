/**
 * The words around a demo reset. The confirmation has to say how many merged commits go before
 * the person agrees, and the result must never claim a redeploy that did not start.
 */
import { describe, expect, it } from "vitest";
import { describeReset, describeSitePreview } from "@/lib/demo/describe";
import type { MainSummary, ProductMapSummary, ResetSummary, SiteSummary } from "@/lib/demo/reset";

const MAIN_RESET: MainSummary = {
  outcome: "reset",
  commitsSinceBaseline: 3,
  removedSince: "2026-11-18T08:40:00.000Z",
  baselineSha: "b".repeat(40),
  mainSha: "m".repeat(40),
  problem: null,
};

const DEPLOYING: SiteSummary = {
  outcome: "deploying",
  project: "novaair",
  deployment: { id: "dpl_new", url: "https://novaair-new.vercel.app/", inspectorUrl: "https://vercel.com/a/novaair/dpl_new" },
  problem: null,
};

const FORGOTTEN: ProductMapSummary = {
  since: "2026-11-18T08:40:00.000Z",
  controls: 11,
  pages: 1,
  transitions: 4,
  problem: null,
};

const UNTOUCHED: ProductMapSummary = { since: null, controls: 0, pages: 0, transitions: 0, problem: null };

function summary(overrides: Partial<ResetSummary> = {}): ResetSummary {
  return {
    dryRun: false,
    repo: "acme/novaair",
    issuesClosed: 1,
    pullRequestsClosed: 1,
    branchesDeleted: 1,
    main: MAIN_RESET,
    site: DEPLOYING,
    productMap: FORGOTTEN,
    traceEvents: 9,
    escalations: 1,
    requestGroups: 1,
    conversations: 2,
    knownRoutes: 0,
    problems: [],
    ...overrides,
  };
}

describe("describeSitePreview", () => {
  it("says how many merged commits a reset removes and that the site redeploys", () => {
    expect(describeSitePreview({ main: MAIN_RESET, site: { ...DEPLOYING, deployment: null }, productMap: FORGOTTEN })).toEqual([
      "Every change merged into the demo site since the demo-baseline tag is removed. Main goes back to the tag, which takes away 3 commits.",
      "The product map forgets the 11 controls it first saw after the first of those commits, so the agent stops pointing at them.",
      "Vercel then deploys the baseline. The site is back in about a minute.",
    ]);
  });

  it("uses the singular for one commit", () => {
    const [first] = describeSitePreview({ main: { ...MAIN_RESET, commitsSinceBaseline: 1 }, site: DEPLOYING, productMap: FORGOTTEN });
    expect(first).toContain("which takes away 1 commit.");
  });

  it("says nothing is removed when main is already at the baseline", () => {
    const lines = describeSitePreview({
      main: { ...MAIN_RESET, outcome: "at-baseline", commitsSinceBaseline: 0 },
      site: { ...DEPLOYING, outcome: "serving" },
      productMap: UNTOUCHED,
    });
    expect(lines).toEqual([
      "Main is already at the demo-baseline tag, so no commits are removed.",
      "The site already serves the baseline.",
    ]);
  });

  it("shows why main stays where it is", () => {
    const problem = "acme/novaair has no demo-baseline tag, so main stays where it is.";
    const lines = describeSitePreview({
      main: { ...MAIN_RESET, outcome: "no-baseline", commitsSinceBaseline: 0, problem },
      site: { outcome: "skipped", project: "novaair", deployment: null, problem: null },
      productMap: UNTOUCHED,
    });
    expect(lines).toEqual([problem]);
  });

  it("shows why the site would not be redeployed", () => {
    const problem = "No Vercel token is configured, so the demo site is not redeployed.";
    const lines = describeSitePreview({
      main: MAIN_RESET,
      site: { outcome: "failed", project: "novaair", deployment: null, problem },
      productMap: UNTOUCHED,
    });
    expect(lines[1]).toBe(problem);
  });
});

describe("describeReset", () => {
  it("says how many merged commits went and links the deployment", () => {
    expect(describeReset(summary())).toEqual([
      { text: "Cleared 2 conversations, 1 request, 2 closed on GitHub.", problem: false },
      { text: "Removed the 3 commits merged into the demo site since the baseline.", problem: false },
      { text: "The product map forgot 11 controls it first saw after the first removed commit.", problem: false },
      {
        text: "The site is redeploying from the baseline and is back in about a minute.",
        problem: false,
        link: { href: "https://vercel.com/a/novaair/dpl_new", label: "Follow the deployment on Vercel" },
      },
    ]);
  });

  it("claims no redeploy when Vercel refused, and shows the problem", () => {
    const problem = "Vercel refused to deploy the demo-baseline commit (bbbbbbb) to novaair (403: Not authorized).";
    const lines = describeReset(
      summary({ site: { outcome: "failed", project: "novaair", deployment: null, problem }, problems: [problem] }),
    );
    expect(lines.some((line) => line.text.includes("redeploying"))).toBe(false);
    expect(lines.at(-1)).toEqual({ text: problem, problem: true });
  });

  it("claims no removed commits when GitHub refused the update", () => {
    const problem = "GitHub refused to move main back to the demo-baseline tag (422: protected).";
    const lines = describeReset(
      summary({
        main: { ...MAIN_RESET, outcome: "failed", problem },
        site: { outcome: "skipped", project: "novaair", deployment: null, problem: null },
        productMap: UNTOUCHED,
        problems: [problem],
      }),
    );
    expect(lines.map((line) => line.text)).toEqual(["Cleared 2 conversations, 1 request, 2 closed on GitHub.", problem]);
  });

  it("names a product map that could not be cleared as a problem, not as done", () => {
    const problem = "The product map could not forget the controls of the removed changes (transition answered 401).";
    const lines = describeReset(summary({ productMap: { ...FORGOTTEN, controls: 0, problem }, problems: [problem] }));
    expect(lines.some((line) => line.text.startsWith("The product map forgot"))).toBe(false);
    expect(lines.at(-1)).toEqual({ text: problem, problem: true });
  });

  it("says so when the map had nothing from the removed changes", () => {
    const lines = describeReset(summary({ productMap: { ...FORGOTTEN, controls: 0 } }));
    expect(lines[2]?.text).toBe("The product map had no controls from after the first removed commit to forget.");
  });
});
