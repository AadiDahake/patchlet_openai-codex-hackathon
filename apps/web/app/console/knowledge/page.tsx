import { redirect } from "next/navigation";
import { KnowledgeConsole } from "@/components/console/knowledge/KnowledgeConsole";
import { currentProjectOrNull } from "@/lib/console/current";
import { DOCUMENT_COLUMNS, toConsoleDocument } from "@/lib/ingest/run";
import type { ConsoleDocument } from "@/lib/ingest/types";
import { serviceClient } from "@/lib/supabase";

export const dynamic = "force-dynamic";

export default async function KnowledgePage() {
  const project = await currentProjectOrNull();
  if (!project) redirect("/signin");
  const documents = await loadDocuments(project.id);

  // The heading is drawn by the console itself, because the switch between the list, the graph
  // and the vector store sits in it.
  return (
    <KnowledgeConsole
      initialDocuments={documents}
      siteUrl={project.siteUrl}
      repoBound={Boolean(project.repoFullName)}
    />
  );
}

async function loadDocuments(projectId: string): Promise<ConsoleDocument[]> {
  const { data } = await serviceClient()
    .from("document")
    .select(DOCUMENT_COLUMNS)
    .eq("project_id", projectId)
    .order("created_at", { ascending: false });
  return (data ?? []).map(toConsoleDocument);
}
