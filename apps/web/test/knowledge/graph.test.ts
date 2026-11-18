import { describe, expect, it } from "vitest";
import {
  PASSAGES_ALWAYS_DRAWN,
  exists,
  indexMap,
  litBy,
  nodeKey,
  openedBy,
  pageRadius,
  plural,
  sourceRadius,
  visibleGraph,
  type NodeRef,
  type Opened,
} from "@/lib/knowledge/graph";
import { excerpt, searchNodes } from "@/lib/knowledge/search";
import { shapeKnowledgeMap } from "@/lib/knowledge/shape";
import { documents, graph, index } from "./fixtures";

const nothing: Opened = { sourceId: null, route: null };
const kinds = (nodes: { kind: string }[]): Record<string, number> => {
  const tally: Record<string, number> = {};
  for (const node of nodes) tally[node.kind] = (tally[node.kind] ?? 0) + 1;
  return tally;
};

describe("visibleGraph", () => {
  it("draws every source, passage and page, and no control, when nothing is selected", () => {
    const { nodes, links } = visibleGraph(index, nothing);
    expect(kinds(nodes)).toEqual({ source: 3, passage: 6, page: 3 });
    expect(kinds(links)).toEqual({ holds: 6, read: 2, move: 2 });
  });

  it("draws the two directions between two pages as one line that stands for all their rows", () => {
    const moves = visibleGraph(index, nothing).links.filter((link) => link.kind === "move");
    expect(moves.map((link) => [link.source, link.target, link.weight])).toEqual([
      ["g:/", "g:/help/check-in", 3],
      ["g:/", "g:/trips/:id", 1],
    ]);
  });

  it("never draws a line whose two ends are not both drawn", () => {
    for (const open of [nothing, { sourceId: null, route: "/" }, { sourceId: "doc-site", route: null }]) {
      const { nodes, links } = visibleGraph(index, open);
      const keys = new Set(nodes.map((node) => node.key));
      expect(new Set(nodes.map((node) => node.key)).size).toBe(nodes.length);
      expect(new Set(links.map((link) => link.key)).size).toBe(links.length);
      expect(links.every((link) => keys.has(link.source) && keys.has(link.target))).toBe(true);
    }
  });

  it("opens a page's controls, and what each one does, while the page is selected", () => {
    const { nodes, links } = visibleGraph(index, openedBy(index, { kind: "page", id: "/" }));
    expect(kinds(nodes)).toEqual({ source: 3, passage: 6, page: 3, control: 4 });
    expect(links.filter((link) => link.kind === "on")).toHaveLength(4);
    expect(links.filter((link) => link.kind === "opens").map((link) => [link.source, link.target])).toEqual([
      ["c:c-home-help", "g:/help/check-in"],
      ["c:c-home-trips", "g:/trips/:id"],
    ]);
    expect(links.filter((link) => link.kind === "reveals").map((link) => [link.source, link.target])).toEqual([
      ["c:c-home-menu", "c:c-home-out"],
    ]);
  });

  it("keeps a page open while one of its controls is selected, and closes it for anything else", () => {
    expect(openedBy(index, { kind: "control", id: "c-help-home" })).toEqual({ sourceId: null, route: "/help/check-in" });
    expect(openedBy(index, { kind: "passage", id: "p-site-2" })).toEqual({ sourceId: "doc-site", route: null });
    expect(openedBy(index, { kind: "source", id: "doc-note" })).toEqual({ sourceId: "doc-note", route: null });
    expect(openedBy(index, null)).toEqual(nothing);
    expect(openedBy(index, { kind: "control", id: "gone" })).toEqual(nothing);
  });

  it("draws two controls that open the same page as two lines, and the same link only once", () => {
    const { links } = visibleGraph(index, { sourceId: null, route: "/help/check-in" });
    expect(links.filter((link) => link.kind === "opens").map((link) => link.source)).toEqual([
      "c:c-help-home",
      "c:c-help-logo",
    ]);
  });

  /** A handbook of a thousand passages would bury the picture, so a large store opens one source at a time. */
  it("draws a large store's passages only for the source that is selected", () => {
    const many = Array.from({ length: PASSAGES_ALWAYS_DRAWN + 1 }, (_, n) => ({
      id: `p-${n}`,
      documentId: n % 2 === 0 ? "doc-site" : "doc-note",
      ordinal: n,
      heading: `Passage ${n}`,
      content: "text",
      page: null,
      confidence: null,
      sourceRef: null,
    }));
    const large = indexMap(shapeKnowledgeMap({ documents, passages: many, graph }));
    expect(kinds(visibleGraph(large, nothing).nodes)).toEqual({ source: 3, page: 3 });
    const open = visibleGraph(large, openedBy(large, { kind: "passage", id: "p-1" }));
    expect(kinds(open.nodes).passage).toBe(many.filter((row) => row.documentId === "doc-note").length);
    expect(open.nodes.filter((node) => node.kind === "passage").every((node) => node.parent === "s:doc-note")).toBe(true);
  });

  it("sizes a source by its passages and a page by its controls, within limits", () => {
    expect(sourceRadius(5)).toBeLessThan(sourceRadius(64));
    expect(sourceRadius(0)).toBe(8);
    expect(sourceRadius(100000)).toBe(22);
    expect(pageRadius(20)).toBeLessThan(pageRadius(205));
    expect(pageRadius(100000)).toBe(18);
  });

  it("gives every kind of node its own key space", () => {
    expect(new Set([nodeKey("source", "x"), nodeKey("passage", "x"), nodeKey("page", "x"), nodeKey("control", "x")]).size).toBe(4);
    expect(plural(1, "passage")).toBe("1 passage");
    expect(plural(1234, "control")).toBe("1,234 controls");
  });
});

describe("litBy", () => {
  const lit = (focus: NodeRef | null, open = nothing) => {
    const result = litBy(index, visibleGraph(index, open), focus);
    return result ? { nodes: [...result.nodes].sort(), links: [...result.links].sort() } : null;
  };

  it("lights nothing when nothing is pointed at", () => {
    expect(lit(null)).toBeNull();
  });

  it("lights a source with its passages and the pages it was read from", () => {
    expect(lit({ kind: "source", id: "doc-site" })).toEqual({
      nodes: ["g:/", "g:/help/check-in", "p:p-site-1", "p:p-site-2", "p:p-site-3", "s:doc-site"],
      links: ["holds:p-site-1", "holds:p-site-2", "holds:p-site-3", "read:doc-site:/", "read:doc-site:/help/check-in"],
    });
  });

  it("lights a passage with its source, the page it was read from and the line between them", () => {
    expect(lit({ kind: "passage", id: "p-site-2" })).toEqual({
      nodes: ["g:/help/check-in", "p:p-site-2", "s:doc-site"],
      links: ["holds:p-site-2", "read:doc-site:/help/check-in"],
    });
    // Read from a laptop: there is no page to light.
    expect(lit({ kind: "passage", id: "p-article-1" })).toEqual({
      nodes: ["p:p-article-1", "s:doc-article"],
      links: ["holds:p-article-1"],
    });
  });

  it("lights a page with the pages it leads to and the sources read from it", () => {
    expect(lit({ kind: "page", id: "/help/check-in" })?.nodes).toEqual(["g:/", "g:/help/check-in", "s:doc-site"]);
  });

  it("lights an open control with its page and the page it opens", () => {
    expect(lit({ kind: "control", id: "c-home-help" }, { sourceId: null, route: "/" })).toEqual({
      nodes: ["c:c-home-help", "g:/", "g:/help/check-in"],
      links: ["on:c-home-help", "opens:c-home-help:/help/check-in"],
    });
  });
});

describe("exists", () => {
  it("tells a node that is still in the map from one a reload removed", () => {
    expect(exists(index, { kind: "passage", id: "p-site-1" })).toBe(true);
    expect(exists(index, { kind: "passage", id: "p-orphan" })).toBe(false);
    expect(exists(index, { kind: "page", id: "/hotels" })).toBe(false);
    expect(exists(index, { kind: "control", id: "c-home-menu" })).toBe(true);
    expect(exists(index, { kind: "source", id: "doc-note" })).toBe(true);
  });
});

describe("searchNodes", () => {
  const found = (query: string) => searchNodes(index, query).map((hit) => `${hit.kind}:${hit.label}`);

  it("matches nothing for an empty query", () => {
    expect(searchNodes(index, "   ")).toEqual([]);
  });

  it("finds every kind of node by its name, a source and a page before a passage", () => {
    expect(found("check")).toEqual(["source:Check-in", "page:Check-in", "passage:When to check in", "passage:When to check in"]);
    expect(found("menu")).toEqual(["control:Menu"]);
    expect(found("manage trip")).toEqual(["page:Manage Trip"]);
  });

  it("finds a passage by its text and shows the words around the match", () => {
    const [hit] = searchNodes(index, "bag drop");
    expect(hit).toMatchObject({ kind: "passage", label: "At the airport" });
    expect(hit?.context).toContain("Bag drop closes 45 minutes");
  });

  it("needs every word of the query, in any order and any case", () => {
    expect(found("AIRPORT the at")).toEqual(["passage:At the airport", "passage:At the airport"]);
    expect(found("airport hotel")).toEqual([]);
  });

  it("finds a page by its route and a control by its role", () => {
    expect(found("/trips")).toEqual(["page:Manage Trip"]);
    expect(found("button")).toEqual(["control:Menu", "control:Sign out"]);
  });

  it("says where a hit sits, never with a loopback host", () => {
    const hits = searchNodes(index, "check-in");
    expect(hits.find((hit) => hit.kind === "source")?.context).toBe("2 passages");
    expect(hits.find((hit) => hit.kind === "page")?.context).toBe("/help/check-in");
    expect(JSON.stringify(searchNodes(index, "e", 50))).not.toMatch(/localhost/);
  });

  it("returns no more than the limit", () => {
    expect(searchNodes(index, "e", 3)).toHaveLength(3);
  });

  it("cuts a long passage around the match", () => {
    const long = `${"filler ".repeat(40)}the needle is here ${"filler ".repeat(40)}`;
    const cut = excerpt(long, ["needle"]);
    expect(cut).toContain("needle");
    expect(cut.length).toBeLessThanOrEqual(74);
    expect(cut.startsWith("\u2026") && cut.endsWith("\u2026")).toBe(true);
  });
});
