/** The passages nearest to one passage of the signed-in project, straight from pgvector. */
import { asErrorResponse, currentProject } from "@/lib/console/current";
import { nearestPassages } from "@/lib/knowledge/load";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request): Promise<Response> {
  const passage = new URL(request.url).searchParams.get("passage") ?? "";
  if (!UUID.test(passage)) return Response.json({ error: "Name a passage." }, { status: 400 });

  const project = await currentProject().catch(asErrorResponse);
  if (project instanceof Response) return project;

  try {
    const near = await nearestPassages(project.id, passage);
    if (!near) return Response.json({ error: "That passage is not in this project." }, { status: 404 });
    return Response.json({ near });
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 500 });
  }
}
