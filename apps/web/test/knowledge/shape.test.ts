import { describe, expect, it } from "vitest";
import { displayAddress, pageForAddress } from "@/lib/knowledge/address";
import { clip, pageLabel, passageLabel, sharedSiteName } from "@/lib/knowledge/labels";
import { shapeKnowledgeMap } from "@/lib/knowledge/shape";
import { parseVector } from "@/lib/knowledge/vector";
import { documents, graph, map, passages } from "./fixtures";

describe("displayAddress", () => {
  it("shows a public page as its host and path", () => {
    expect(displayAddress("https://novaair.vercel.app/help/check-in")).toBe("novaair.vercel.app/help/check-in");
    expect(displayAddress("https://novaair.vercel.app/")).toBe("novaair.vercel.app");
    expect(displayAddress("https://novaair.vercel.app/help/?utm=1")).toBe("novaair.vercel.app/help");
  });

  /**
   * Six of NovaAir's seven sources were read from a developer's machine, so their stored address
   * is `http://localhost:4100/...`. The host says nothing to the person reading the console.
   */
  it("never shows a loopback host: the path stands for the page", () => {
    for (const host of ["localhost:4100", "127.0.0.1:3000", "0.0.0.0", "[::1]:8080", "app.localhost", "laptop.local"]) {
      const shown = displayAddress(`http://${host}/help/check-in`);
      expect(shown).toBe("/help/check-in");
    }
    expect(displayAddress("http://localhost:4100")).toBe("/");
  });

  it("leaves a file name alone and has nothing to say for nothing", () => {
    expect(displayAddress("handbook.pdf")).toBe("handbook.pdf");
    expect(displayAddress(null)).toBeNull();
    expect(displayAddress("  ")).toBeNull();
  });
});

describe("pageForAddress", () => {
  it("finds the page whose own address this is", () => {
    expect(pageForAddress("https://novaair.vercel.app/help/check-in", graph.pages)).toBe("/help/check-in");
    expect(pageForAddress("https://novaair.vercel.app/trips/QRX9P1", graph.pages)).toBe("/trips/:id");
    expect(pageForAddress("https://novaair.vercel.app", graph.pages)).toBe("/");
  });

  /**
   * The same path on another origin is another copy of the product. The data holds no link from
   * that copy to this project's page, so none is drawn.
   */
  it("refuses the same route on another origin", () => {
    expect(pageForAddress("http://localhost:4100/help/check-in", graph.pages)).toBeNull();
    expect(pageForAddress("https://novaair-preview.vercel.app/help/check-in", graph.pages)).toBeNull();
    expect(pageForAddress("http://novaair.vercel.app/help/check-in", graph.pages)).toBeNull();
  });

  it("refuses a route the map has not got, and anything that is not an address", () => {
    expect(pageForAddress("https://novaair.vercel.app/hotels", graph.pages)).toBeNull();
    expect(pageForAddress("handbook.pdf", graph.pages)).toBeNull();
    expect(pageForAddress(null, graph.pages)).toBeNull();
  });
});

describe("labels", () => {
  it("names a passage by its heading, or by how it starts", () => {
    expect(passageLabel("Seating rule", "A child under 13 sits next to an adult.")).toBe("Seating rule");
    expect(passageLabel(null, "## Billing\n\nquestions belong to the owner")).toBe("Billing questions belong to the\u2026");
    expect(passageLabel(null, "- Rows 15 and 16 are exit rows.")).toBe("Rows 15 and 16 are exit rows.");
    expect(passageLabel("  ", "")).toBe("Untitled passage");
  });

  it("cuts a long label at a word and says that it cut", () => {
    const cut = clip("When NovaAir changes your flight after you have already checked in");
    expect(cut.length).toBeLessThanOrEqual(34);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).toBe("When NovaAir changes your flight…");
  });

  it("finds the site name most page titles end with", () => {
    expect(sharedSiteName(["NovaAir", "Check-in | NovaAir", "Manage Trip | NovaAir"])).toBe("NovaAir");
    expect(sharedSiteName(["Pricing - Acme", "Docs - Acme", "Blog"])).toBe("Acme");
    // One title is not a pattern, and neither are titles that share nothing.
    expect(sharedSiteName(["Check-in | NovaAir"])).toBeNull();
    expect(sharedSiteName(["Pricing", "Docs", "Blog | Acme"])).toBeNull();
    expect(sharedSiteName([])).toBeNull();
  });

  it("drops the site name from a page label and keeps a hyphenated title whole", () => {
    expect(pageLabel("Check-in | NovaAir", "/help/check-in", "NovaAir")).toBe("Check-in");
    expect(pageLabel("NovaAir", "/", "NovaAir")).toBe("NovaAir");
    expect(pageLabel("Seats | Trip | NovaAir", "/s", "NovaAir")).toBe("Seats | Trip");
    expect(pageLabel("", "/trips/:id/seats", "NovaAir")).toBe("/trips/:id/seats");
  });
});

describe("shapeKnowledgeMap", () => {
  it("states the totals the Knowledge and Product map pages state", () => {
    expect(map.totals).toEqual({ sources: 3, passages: 6, pages: 3, controls: 6, transitions: 5 });
  });

  it("keeps every source and shows no loopback address", () => {
    expect(map.sources.map((source) => [source.title, source.address, source.passageCount])).toEqual([
      ["Check-in", "/help/check-in", 2],
      ["Every seat, in plain sight.", "novaair.vercel.app", 3],
      ["Escalation notes", null, 1],
    ]);
    expect(JSON.stringify(map)).not.toMatch(/localhost/);
  });

  it("hangs every passage from its source and drops one whose source is gone", () => {
    expect(map.passages.map((passage) => passage.id)).toEqual([
      "p-article-1",
      "p-article-2",
      "p-site-1",
      "p-site-2",
      "p-site-3",
      "p-note-1",
    ]);
    expect(map.passages.find((passage) => passage.id === "p-note-1")?.label).toBe("Billing questions belong to the…");
  });

  it("ties a source to a page only when a passage carries that page's own address", () => {
    expect(map.readLinks).toEqual([
      { sourceId: "doc-site", route: "/", passages: 1 },
      { sourceId: "doc-site", route: "/help/check-in", passages: 2 },
    ]);
    // The article is the same page read from a laptop: no link.
    expect(map.readLinks.some((link) => link.sourceId === "doc-article")).toBe(false);
    expect(map.passages.find((passage) => passage.id === "p-site-2")?.readFrom).toBe("/help/check-in");
    expect(map.passages.find((passage) => passage.id === "p-article-1")?.readFrom).toBeNull();
  });

  it("falls back to the source's address for a passage that has none of its own", () => {
    const shaped = shapeKnowledgeMap({
      documents: [{ ...documents[1]!, sourceRef: "https://novaair.vercel.app/help/check-in" }],
      passages: [{ ...passages[2]!, sourceRef: null }],
      graph,
    });
    expect(shaped.readLinks).toEqual([{ sourceId: "doc-site", route: "/help/check-in", passages: 1 }]);
  });

  it("labels pages with their titles and counts their controls", () => {
    expect(map.pages).toEqual([
      { route: "/", title: "NovaAir", label: "NovaAir", controlCount: 4 },
      { route: "/help/check-in", title: "Check-in | NovaAir", label: "Check-in", controlCount: 2 },
      { route: "/trips/:id", title: "Manage Trip | NovaAir", label: "Manage Trip", controlCount: 0 },
    ]);
  });

  it("draws the transitions between two pages as one move with a count", () => {
    expect(map.moves).toEqual([
      { from: "/", to: "/help/check-in", count: 1 },
      { from: "/", to: "/trips/:id", count: 1 },
      { from: "/help/check-in", to: "/", count: 2 },
    ]);
    // Every transition row is still counted, the reveal included.
    expect(map.moves.reduce((total, move) => total + move.count, 0) + 1).toBe(map.totals.transitions);
  });

  it("keeps what each control does for the moment its page is opened", () => {
    expect(map.controlLinks).toEqual([
      { controlId: "c-home-help", toRoute: "/help/check-in", revealsControlId: null },
      { controlId: "c-home-trips", toRoute: "/trips/:id", revealsControlId: null },
      { controlId: "c-help-home", toRoute: "/", revealsControlId: null },
      { controlId: "c-help-logo", toRoute: "/", revealsControlId: null },
      { controlId: "c-home-menu", toRoute: null, revealsControlId: "c-home-out" },
    ]);
  });

  it("has nothing to draw for a project with no knowledge", () => {
    const empty = shapeKnowledgeMap({ documents: [], passages: [], graph: { pages: [], controls: [], transitions: [] } });
    expect(empty.totals).toEqual({ sources: 0, passages: 0, pages: 0, controls: 0, transitions: 0 });
    expect([empty.sources, empty.passages, empty.pages, empty.controls, empty.moves, empty.readLinks]).toEqual([
      [],
      [],
      [],
      [],
      [],
      [],
    ]);
  });
});

describe("parseVector", () => {
  it("reads the text pgvector hands over", () => {
    expect(parseVector("[0.25,-1,3e-2]")).toEqual([0.25, -1, 0.03]);
    expect(parseVector([1, 2])).toEqual([1, 2]);
  });

  it("refuses anything that is not a vector of finite numbers", () => {
    for (const bad of ["", "[]", "not json", "[1,null]", '["1"]', "{}", null, undefined, [1, Number.NaN], 7]) {
      expect(parseVector(bad)).toBeNull();
    }
  });
});
