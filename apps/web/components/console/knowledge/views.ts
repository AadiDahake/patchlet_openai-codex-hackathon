/** The three ways the Knowledge page shows what the agent knows, and what each one says it is. */
export const KNOWLEDGE_VIEWS = {
  sources: {
    label: "Sources",
    description:
      "Add a handbook, a documentation site or a note. Patchlet reads it, splits it into passages and remembers how well it read each one.",
  },
  graph: {
    label: "Graph",
    description:
      "What the agent has read and seen, and the links the stored data holds.",
  },
  vectors: {
    label: "Vectors",
    description:
      "Every passage as a point. Passages that read alike sit close together.",
  },
} as const;

export type KnowledgeView = keyof typeof KNOWLEDGE_VIEWS;

/** The view an address asks for. Anything it does not name is the list of sources. */
export function viewFromQuery(value: string | null | undefined): KnowledgeView {
  return value === "graph" || value === "vectors" ? value : "sources";
}
