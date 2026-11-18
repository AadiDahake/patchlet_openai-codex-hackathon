/**
 * Puts the demo back to its starting position.
 *
 * This closes real issues and pull requests, deletes real rows, moves the bound repository's
 * `main` back to its `demo-baseline` tag, starts a production deployment of that commit and makes
 * the product map forget the controls the removed changes added, all of them the caller's own.
 * The rules that make the forced update safe from a button are in `lib/demo/reset.ts`. The
 * knowledge base is never touched.
 *
 * `GET` changes nothing: it reports what a reset would do to `main`, the site and the product map,
 * so the confirmation can say how many commits go before the person agrees.
 */
import { asErrorResponse, currentProject } from "@/lib/console/current";
import type { ConsoleProject } from "@/lib/console/project";
import { activeGithubToken } from "@/lib/github/connection";
import { checkSiteReset, resetDemo, type SiteResetOptions } from "@/lib/demo/reset";
import { targetVercelProject, vercelTokenIfSet } from "@/lib/env";
import { corsJson, preflight } from "@/lib/cors";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;

export function OPTIONS(): Response {
  return preflight();
}

/**
 * Where the site's code lives, where it is served from, and where the product map is kept, all
 * for the caller's own project. A missing credential is a null.
 */
async function siteOptions(project: ConsoleProject): Promise<SiteResetOptions> {
  return {
    repo: project.repoFullName,
    githubToken: await activeGithubToken(project.id).catch(() => null),
    vercelToken: vercelTokenIfSet(),
    vercelProject: targetVercelProject(),
    supabaseUrl: process.env.SUPABASE_URL ?? null,
    supabaseKey: process.env.SUPABASE_SERVICE_ROLE_KEY ?? null,
    projectId: project.id,
  };
}

export async function GET(): Promise<Response> {
  const project = await currentProject().catch(asErrorResponse);
  if (project instanceof Response) return project;

  try {
    return corsJson(await checkSiteReset(await siteOptions(project)));
  } catch (error) {
    return corsJson({ error: (error as Error).message }, { status: 500 });
  }
}

export async function POST(): Promise<Response> {
  const project = await currentProject().catch(asErrorResponse);
  if (project instanceof Response) return project;

  try {
    const summary = await resetDemo({
      ...(await siteOptions(project)),
      main: "reset",
    });
    return corsJson({ summary });
  } catch (error) {
    return corsJson({ error: (error as Error).message }, { status: 500 });
  }
}
