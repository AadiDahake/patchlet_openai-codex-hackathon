/** What the agent knows about the signed-in project, as the nodes and links the Knowledge page draws. */
import { asErrorResponse, currentProject } from "@/lib/console/current";
import { loadKnowledgeMap } from "@/lib/knowledge/load";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const project = await currentProject().catch(asErrorResponse);
  if (project instanceof Response) return project;

  try {
    return Response.json({ map: await loadKnowledgeMap(project.id) });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
