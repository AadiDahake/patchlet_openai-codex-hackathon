/**
 * The project's vector store as a picture: two numbers per passage, computed here from the stored
 * vectors. The vectors themselves are never sent.
 */
import { asErrorResponse, currentProject } from "@/lib/console/current";
import { loadVectorLayout } from "@/lib/knowledge/load";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  const project = await currentProject().catch(asErrorResponse);
  if (project instanceof Response) return project;

  try {
    return Response.json({ layout: await loadVectorLayout(project.id) });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
