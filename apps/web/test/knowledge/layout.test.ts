import { describe, expect, it } from "vitest";
import { openedBy, visibleGraph } from "@/lib/knowledge/graph";
import { GraphLayout, crowdedNames, nameWidth, type NameBox } from "@/lib/knowledge/layout";
import { index } from "./fixtures";

const closed = visibleGraph(index, { sourceId: null, route: null });

function settled(lie: "wide" | "tall" = "wide"): GraphLayout {
  const layout = new GraphLayout(new Map(), lie);
  layout.update(closed);
  layout.settle();
  return layout;
}

const spread = (layout: GraphLayout, kind: string, axis: "x" | "y"): number => {
  const nodes = [...layout.nodes.values()].filter((node) => node.kind === kind);
  return nodes.reduce((sum, node) => sum + node[axis], 0) / nodes.length;
};

describe("GraphLayout", () => {
  it("settles to the same picture every time", () => {
    expect(settled().positions()).toEqual(settled().positions());
  });

  it("comes to rest: no timer is left running", () => {
    const layout = settled();
    expect(layout.moving).toBe(false);
    expect([...layout.nodes.values()].every((node) => Number.isFinite(node.x) && Number.isFinite(node.y))).toBe(true);
  });

  it("places every node the graph has and every line between two of them", () => {
    const layout = settled();
    expect(layout.nodes.size).toBe(closed.nodes.length);
    expect(layout.wires.map((wire) => wire.key).sort()).toEqual(closed.links.map((link) => link.key).sort());
  });

  it("sets what was read on one side and the product on the other", () => {
    const wide = settled("wide");
    expect(spread(wide, "source", "x")).toBeLessThan(spread(wide, "page", "x") - 100);
    const tall = settled("tall");
    expect(spread(tall, "source", "y")).toBeLessThan(spread(tall, "page", "y") - 100);
  });

  it("keeps a passage beside its own source", () => {
    const layout = settled();
    for (const node of layout.nodes.values()) {
      if (node.kind !== "passage" || !node.parent) continue;
      const source = layout.nodes.get(node.parent)!;
      expect(Math.hypot(node.x - source.x, node.y - source.y)).toBeLessThan(80);
    }
  });

  it("leaves room for every name: no two named nodes are drawn over each other", () => {
    const layout = settled();
    const named = [...layout.nodes.values()].filter((node) => node.kind === "source" || node.kind === "page");
    const boxes: NameBox[] = named.map((node) => ({
      key: node.key,
      x: node.x,
      y: node.y + node.radius + 14,
      width: nameWidth(node.label),
      height: 16,
      rank: node.radius,
    }));
    expect(crowdedNames(boxes).size).toBe(0);
  });

  it("opens a page beside it, without moving a node that stays", () => {
    const layout = settled();
    const before = layout.positions();
    const added = layout.update(visibleGraph(index, openedBy(index, { kind: "page", id: "/" })));
    expect(added).toBe(4);
    const page = layout.nodes.get("g:/")!;
    for (const node of layout.nodes.values()) {
      if (node.kind === "control") expect(Math.hypot(node.x - page.x, node.y - page.y)).toBeLessThan(60);
      else expect({ x: node.x, y: node.y }).toEqual(before.get(node.key));
    }
    // Closing it again takes the controls away and keeps everything else.
    expect(layout.update(closed)).toBe(0);
    expect(layout.nodes.size).toBe(closed.nodes.length);
  });

  it("puts nodes back where an earlier layout left them", () => {
    const saved = settled().positions();
    const again = new GraphLayout(saved);
    expect(again.update(closed)).toBe(0);
    expect(again.positions()).toEqual(saved);
  });

  it("measures the box around all of it, or around some of it", () => {
    const layout = settled();
    const whole = layout.bounds()!;
    const one = layout.bounds(["g:/"])!;
    expect(whole.x0).toBeLessThanOrEqual(one.x0);
    expect(whole.x1).toBeGreaterThanOrEqual(one.x1);
    expect(new GraphLayout().bounds()).toBeNull();
  });
});

describe("crowdedNames", () => {
  const box = (key: string, x: number, y: number, rank: number, width = 100): NameBox => ({ key, x, y, width, height: 16, rank });

  it("leaves out the lower ranked of two names that overlap", () => {
    expect([...crowdedNames([box("small", 0, 0, 1), box("large", 40, 4, 9)])]).toEqual(["small"]);
  });

  it("keeps names that are clear of each other, side by side or one above the other", () => {
    expect(crowdedNames([box("a", 0, 0, 1), box("b", 101, 0, 1), box("c", 0, 17, 1)]).size).toBe(0);
  });

  it("frees a name once the one that crowded it is itself left out", () => {
    // `b` overlaps `a`, and `c` overlaps only `b`: with `b` gone, `c` has room.
    expect([...crowdedNames([box("a", 0, 0, 9), box("b", 80, 0, 5), box("c", 160, 0, 1)])]).toEqual(["b"]);
  });

  it("decides a tie the same way every time", () => {
    const tie = [box("b", 0, 0, 1), box("a", 10, 0, 1)];
    expect([...crowdedNames(tie)]).toEqual(["b"]);
    expect([...crowdedNames([...tie].reverse())]).toEqual(["b"]);
  });
});
