/**
 * Where the graph's nodes sit. No DOM: a force simulation that a view ticks and a test can run.
 *
 * The same graph always settles into the same picture. Every node starts from a position worked
 * out from its place in the data, and d3-force draws its own jitter from a fixed sequence, so
 * nothing here depends on a clock or a random source.
 *
 * What the agent has read is pulled gently to one side and the product to the other: left and
 * right on a wide stage, top and bottom on a tall one. That is composition, not data: it is what
 * lets the lines between a source and the pages it was read from cross the middle and be seen.
 */
import {
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphLink, GraphNode, LinkKind, NodeKind, VisibleGraph } from "./graph";

export type Point = { x: number; y: number };

/** A node with a position. The simulation owns `x` and `y`; `fx` and `fy` pin it while dragged. */
export type Placed = GraphNode & SimulationNodeDatum & Point;

/** A link whose ends are the placed nodes themselves. */
export type Wire = { key: string; kind: LinkKind; source: Placed; target: Placed };

/**
 * Rest length and pull of each kind of line. A line to something a node owns is short and firm;
 * a line between two pages is long and weak, because a site whose header links everywhere would
 * otherwise pull every page into one knot.
 */
const LINKS: Record<LinkKind, { length: number; pull: number }> = {
  holds: { length: 14, pull: 0.9 },
  on: { length: 12, pull: 0.9 },
  reveals: { length: 22, pull: 0.3 },
  read: { length: 150, pull: 0.08 },
  move: { length: 120, pull: 0.02 },
  opens: { length: 110, pull: 0.01 },
};

const PUSH: Record<NodeKind, number> = { source: -260, page: -220, passage: -30, control: -18 };

/** How far from the middle a source and a page rest: sources before it, pages after it. */
const SIDE: Record<NodeKind, number> = { source: -210, passage: -210, page: 210, control: 210 };

/** Which way the two sides lie: beside each other on a wide stage, above each other on a tall one. */
export type Lie = "wide" | "tall";

/** How much nearer the middle the two sides rest when they are stacked. */
const TALL_SIDE = 0.75;

/** Only the named nodes are pulled to a side. What hangs from them is free to ring them. */
const SIDE_PULL: Record<NodeKind, number> = { source: 0.06, page: 0.06, passage: 0, control: 0 };

/** Room a node keeps clear around itself, as a circle. */
const CLEARANCE: Record<NodeKind, number> = { source: 26, page: 16, passage: 2.2, control: 1.8 };

/**
 * A name is drawn under its node at one size on screen, whatever the zoom. These are that
 * name's measurements at the scale the whole picture is first shown at, which is close to one.
 */
const NAME_CHAR_WIDTH = 6.5;
const NAME_HEIGHT = 20;
const NAME_GAP = 10;

/** How wide a name is drawn, in screen pixels. An estimate: the layout runs without a browser. */
export const nameWidth = (label: string): number => label.length * NAME_CHAR_WIDTH;

/** A name as it lands on the screen: its middle, its size, and how much it matters. */
export type NameBox = { key: string; x: number; y: number; width: number; height: number; rank: number };

/**
 * The names to leave out so that no two are drawn over each other.
 *
 * Names keep one size on screen, so a picture zoomed far out has more names than room. The
 * highest ranked name is placed first and each next one is kept only if it is clear of every
 * name already kept, which is how a map decides which towns to print.
 */
export function crowdedNames(boxes: readonly NameBox[]): Set<string> {
  const kept: NameBox[] = [];
  const crowded = new Set<string>();
  for (const box of [...boxes].sort((a, b) => b.rank - a.rank || (a.key < b.key ? -1 : 1))) {
    const hit = kept.some(
      (other) =>
        Math.abs(other.x - box.x) * 2 < other.width + box.width && Math.abs(other.y - box.y) * 2 < other.height + box.height,
    );
    if (hit) crowded.add(box.key);
    else kept.push(box);
  }
  return crowded;
}

/** Half the width and half the height of a named node together with the name under it. */
function nameBox(node: Placed): { halfWidth: number; halfHeight: number; centreY: number } {
  const halfWidth = Math.max(node.radius, (node.label.length * NAME_CHAR_WIDTH) / 2) + NAME_GAP;
  const halfHeight = node.radius + NAME_HEIGHT / 2 + NAME_GAP / 2;
  return { halfWidth, halfHeight, centreY: node.y + NAME_HEIGHT / 2 };
}

/**
 * Keeps one name from being drawn over another.
 *
 * d3's collision is between circles, and a name is a wide, short box: a circle large enough to
 * clear it would push the nodes above and below far further away than they need to be. Two
 * boxes that overlap are moved apart along whichever axis takes the shorter move.
 */
function forceNameRoom(strength: number): { (alpha: number): void; initialize: (nodes: Placed[]) => void } {
  let named: Placed[] = [];
  let small: Placed[] = [];
  const force = (): void => {
    for (let i = 0; i < named.length; i += 1) {
      const a = named[i] as Placed;
      const boxA = nameBox(a);
      // A dot that hangs from a node must not sit on a name either. Only the dot gives way.
      const top = a.y + a.radius + 1;
      const middle = top + NAME_HEIGHT / 2;
      for (const dot of small) {
        const reach = dot.radius + 2;
        const overlapX = boxA.halfWidth - NAME_GAP + reach - Math.abs(dot.x - a.x);
        const overlapY = NAME_HEIGHT / 2 + reach - Math.abs(dot.y - middle);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (overlapX < overlapY) dot.vx = (dot.vx ?? 0) + overlapX * strength * (dot.x < a.x ? -1 : 1);
        else dot.vy = (dot.vy ?? 0) + overlapY * strength * (dot.y < middle ? -1 : 1);
      }
      for (let j = i + 1; j < named.length; j += 1) {
        const b = named[j] as Placed;
        const boxB = nameBox(b);
        const dx = b.x - a.x;
        const dy = boxB.centreY - boxA.centreY;
        const overlapX = boxA.halfWidth + boxB.halfWidth - Math.abs(dx);
        const overlapY = boxA.halfHeight + boxB.halfHeight - Math.abs(dy);
        if (overlapX <= 0 || overlapY <= 0) continue;
        if (overlapX < overlapY) {
          const move = (overlapX / 2) * strength * (dx < 0 ? -1 : 1);
          a.vx = (a.vx ?? 0) - move;
          b.vx = (b.vx ?? 0) + move;
        } else {
          const move = (overlapY / 2) * strength * (dy < 0 ? -1 : 1);
          a.vy = (a.vy ?? 0) - move;
          b.vy = (b.vy ?? 0) + move;
        }
      }
    }
  };
  force.initialize = (nodes: Placed[]): void => {
    named = nodes.filter((node) => node.kind === "source" || node.kind === "page");
    small = nodes.filter((node) => node.kind === "passage" || node.kind === "control");
  };
  return force;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

/** The nth point of a sunflower spiral: evenly spread, and the same every time. */
function spiral(n: number, spacing: number): Point {
  const radius = spacing * Math.sqrt(n + 0.5);
  const angle = n * GOLDEN_ANGLE;
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

/** A long holds line for a large source, so its passages have a ring to sit on. */
function restLength(link: GraphLink, wire: Wire): number {
  const base = LINKS[link.kind].length;
  if (link.kind !== "holds" && link.kind !== "on") return base;
  return base + wire.source.radius * 1.2;
}

export class GraphLayout {
  readonly nodes = new Map<string, Placed>();
  wires: Wire[] = [];
  private readonly simulation: Simulation<Placed, Wire>;
  private readonly linkForce = forceLink<Placed, Wire>();

  /** `saved` puts nodes back where an earlier layout left them. */
  constructor(
    private readonly saved: ReadonlyMap<string, Point> = new Map(),
    readonly lie: Lie = "wide",
  ) {
    const sidePull = (node: Placed): number => SIDE_PULL[node.kind];
    // The two sides are held apart along one axis and everything is drawn to the middle of the
    // other. A tall stage is a phone's, close to square, so its two sides sit nearer each other.
    const [apart, level] =
      lie === "wide"
        ? [forceX<Placed>((node) => SIDE[node.kind]).strength(sidePull), forceY<Placed>(0).strength(0.09)]
        : [forceY<Placed>((node) => SIDE[node.kind] * TALL_SIDE).strength(sidePull), forceX<Placed>(0).strength(0.06)];
    this.simulation = forceSimulation<Placed, Wire>()
      .force("link", this.linkForce)
      .force("push", forceManyBody<Placed>().strength((node) => PUSH[node.kind]).distanceMax(260))
      .force("room", forceCollide<Placed>((node) => node.radius + CLEARANCE[node.kind]).strength(0.9))
      .force("names", forceNameRoom(0.5))
      .force("side", apart)
      .force("level", level)
      // Below this the nodes move less than a pixel a frame, so the timer stops here instead of
      // running on for another second with nothing to show for it.
      .alphaMin(0.004)
      .stop();
  }

  /**
   * Makes the simulation hold exactly this graph. A node that stays keeps its position; a new
   * one starts beside the node it hangs from. Returns how many nodes are new.
   */
  update(graph: VisibleGraph): number {
    const kept = new Map<string, Placed>();
    const siblings = new Map<string, number>();
    const roots: Record<string, number> = {};
    let added = 0;

    for (const node of graph.nodes) {
      const existing = this.nodes.get(node.key);
      if (existing) {
        kept.set(node.key, Object.assign(existing, node));
        continue;
      }
      const saved = this.saved.get(node.key);
      const parent = node.parent ? (kept.get(node.parent) ?? this.nodes.get(node.parent)) : undefined;
      let start: Point;
      if (saved) start = saved;
      else if (parent) {
        const nth = siblings.get(parent.key) ?? 0;
        siblings.set(parent.key, nth + 1);
        const offset = spiral(nth, 7);
        const reach = parent.radius + 12;
        start = { x: parent.x + offset.x + Math.sign(offset.x || 1) * reach * 0.3, y: parent.y + offset.y };
      } else {
        const nth = roots[node.kind] ?? 0;
        roots[node.kind] = nth + 1;
        const offset = spiral(nth, 62);
        start =
          this.lie === "wide"
            ? { x: SIDE[node.kind] + offset.x, y: offset.y }
            : { x: offset.x, y: SIDE[node.kind] * TALL_SIDE + offset.y };
      }
      if (!saved) added += 1;
      kept.set(node.key, { ...node, x: start.x, y: start.y });
    }

    this.nodes.clear();
    for (const [key, node] of kept) this.nodes.set(key, node);

    this.wires = [];
    const lengths = new Map<string, number>();
    for (const link of graph.links) {
      const source = this.nodes.get(link.source);
      const target = this.nodes.get(link.target);
      if (!source || !target) continue;
      const wire: Wire = { key: link.key, kind: link.kind, source, target };
      lengths.set(link.key, restLength(link, wire));
      this.wires.push(wire);
    }

    this.simulation.nodes([...this.nodes.values()]);
    this.linkForce
      .links(this.wires)
      .distance((wire) => lengths.get(wire.key) ?? 60)
      .strength((wire) => LINKS[wire.kind].pull);
    return added;
  }

  /** Runs the simulation to rest, here and now. */
  settle(from = 1): void {
    this.simulation.stop().alphaTarget(0).alpha(from);
    while (this.simulation.alpha() >= this.simulation.alphaMin()) this.simulation.tick();
  }

  /** Lets the simulation move again and calls `onTick` each frame until it comes to rest. */
  warm(alpha: number, onTick: () => void): void {
    this.simulation.on("tick", onTick).alphaTarget(0).alpha(Math.max(this.simulation.alpha(), alpha)).restart();
  }

  /** Keeps the simulation awake while a node is being dragged, and lets it cool afterwards. */
  hold(active: boolean, onTick: () => void): void {
    this.simulation.on("tick", onTick).alphaTarget(active ? 0.22 : 0);
    if (active) this.simulation.restart();
  }

  /** True while a timer is still ticking. */
  get moving(): boolean {
    return this.simulation.alpha() >= this.simulation.alphaMin();
  }

  stop(): void {
    this.simulation.on("tick", null).stop();
  }

  /** Every node's position, to hand to the next layout. */
  positions(): Map<string, Point> {
    return new Map([...this.nodes].map(([key, node]) => [key, { x: node.x, y: node.y }]));
  }

  /** The box around every node, with room for the names under them. Null when there is none. */
  bounds(): { x0: number; y0: number; x1: number; y1: number } | null {
    let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
    for (const node of this.nodes.values()) {
      const named = node.kind === "source" || node.kind === "page";
      const wide = named ? nameBox(node).halfWidth : node.radius + 2;
      const below = node.radius + (named ? NAME_HEIGHT + NAME_GAP : 2);
      const next = {
        x0: node.x - wide,
        y0: node.y - node.radius - 2,
        x1: node.x + wide,
        y1: node.y + below,
      };
      box = box
        ? {
            x0: Math.min(box.x0, next.x0),
            y0: Math.min(box.y0, next.y0),
            x1: Math.max(box.x1, next.x1),
            y1: Math.max(box.y1, next.y1),
          }
        : next;
    }
    return box;
  }
}
