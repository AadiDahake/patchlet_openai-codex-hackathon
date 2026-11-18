import { describe, expect, it } from "vitest";
import { KNOWLEDGE_VIEWS, viewFromQuery } from "@/components/console/knowledge/views";

describe("viewFromQuery", () => {
  it("opens the list of sources unless the address names a picture", () => {
    expect(viewFromQuery("graph")).toBe("graph");
    expect(viewFromQuery("vectors")).toBe("vectors");
    for (const other of [null, undefined, "", "sources", "Graph", "map"]) expect(viewFromQuery(other)).toBe("sources");
  });

  it("has a label and a one-line description for every view", () => {
    expect(Object.keys(KNOWLEDGE_VIEWS)).toEqual(["sources", "graph", "vectors"]);
    for (const view of Object.values(KNOWLEDGE_VIEWS)) {
      expect(view.label.length).toBeGreaterThan(0);
      expect(view.description.endsWith(".")).toBe(true);
    }
  });
});
