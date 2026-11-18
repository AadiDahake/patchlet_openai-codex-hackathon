/**
 * What the graph view draws for a given selection. Pure, so the rules can be tested without a
 * browser.
 *
 * Sources and pages are always drawn. Controls are not: NovaAir has 469 of them and a page with
 * 205 would bury everything else, so a page shows its controls only while it, or one of them, is
 * selected. Passages follow the same rule once a store is too large to draw whole.
 */
import type { KnowledgeMap, MapControl, MapPage, MapPassage, MapSource } from "./types";

export type NodeKind = "source" | "passage" | "page" | "control";

/** A node by what it is and its own id: a document id, a chunk id, a route, a control id. */
export type NodeRef = { kind: NodeKind; id: string };

export type GraphNode = NodeRef & {
  key: string;
  label: string;
  /** The count a source or a page carries under its name. */
  sub: string | null;
  radius: number;
  /** The node this one hangs from: a passage's source, a control's page. */
  parent: string | null;
};

/**
 * `holds` a source and its passage, `read` a source and the page it was read from, `move` two
 * pages a control leads between, `on` a page and its control, `opens` a control and the page it
 * leads to, `reveals` a control and the control it uncovers.
 */
export type LinkKind = "holds" | "read" | "move" | "on" | "opens" | "reveals";

export type GraphLink = {
  key: string;
  kind: LinkKind;
  source: string;
  target: string;
  /** How many stored rows the line stands for. */
  weight: number;
};

export type VisibleGraph = { nodes: GraphNode[]; links: GraphLink[] };

/** Up to this many passages are all drawn at once; past it a source opens when it is selected. */
export const PASSAGES_ALWAYS_DRAWN = 400;

const PREFIX: Record<NodeKind, string> = { source: "s", passage: "p", page: "g", control: "c" };

export function nodeKey(kind: NodeKind, id: string): string {
  return `${PREFIX[kind]}:${id}`;
}

export const keyOf = (ref: NodeRef): string => nodeKey(ref.kind, ref.id);

export function plural(count: number, noun: string): string {
  return `${count.toLocaleString("en-US")} ${noun}${count === 1 ? "" : "s"}`;
}

/** The map, looked up every way the views need. Built once per load. */
export type MapIndex = {
  map: KnowledgeMap;
  sources: Map<string, MapSource>;
  passages: Map<string, MapPassage>;
  pages: Map<string, MapPage>;
  controls: Map<string, MapControl>;
  passagesBySource: Map<string, MapPassage[]>;
  controlsByRoute: Map<string, MapControl[]>;
};

function groupBy<T>(items: readonly T[], keyFor: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyFor(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

export function indexMap(map: KnowledgeMap): MapIndex {
  return {
    map,
    sources: new Map(map.sources.map((source) => [source.id, source])),
    passages: new Map(map.passages.map((passage) => [passage.id, passage])),
    pages: new Map(map.pages.map((page) => [page.route, page])),
    controls: new Map(map.controls.map((control) => [control.id, control])),
    passagesBySource: groupBy(map.passages, (passage) => passage.sourceId),
    controlsByRoute: groupBy(map.controls, (control) => control.route),
  };
}

/** True when the ref still names something in the map. A reload can remove what was selected. */
export function exists(index: MapIndex, ref: NodeRef): boolean {
  if (ref.kind === "source") return index.sources.has(ref.id);
  if (ref.kind === "passage") return index.passages.has(ref.id);
  if (ref.kind === "page") return index.pages.has(ref.id);
  return index.controls.has(ref.id);
}

/** What a selection opens: the source whose passages show, the page whose controls show. */
export type Opened = { sourceId: string | null; route: string | null };

/** Which source and which page a selection opens. */
export function openedBy(index: MapIndex, selected: NodeRef | null): Opened {
  if (!selected) return { sourceId: null, route: null };
  if (selected.kind === "source") return { sourceId: selected.id, route: null };
  if (selected.kind === "passage") return { sourceId: index.passages.get(selected.id)?.sourceId ?? null, route: null };
  if (selected.kind === "page") return { sourceId: null, route: selected.id };
  return { sourceId: null, route: index.controls.get(selected.id)?.route ?? null };
}

const clamp = (value: number, low: number, high: number): number => Math.min(high, Math.max(low, value));

/** A source grows with what it holds and a page with what is on it, by area and within limits. */
export const sourceRadius = (passages: number): number => clamp(7 + 1.6 * Math.sqrt(passages), 8, 22);
export const pageRadius = (controls: number): number => clamp(6 + 0.75 * Math.sqrt(controls), 7, 18);
export const PASSAGE_RADIUS = 3.6;
export const CONTROL_RADIUS = 2.8;

/** The two ends in a fixed order, so both directions of a move are the same line. */
function pairKey(a: string, b: string): string {
  return a < b ? `${a}\n${b}` : `${b}\n${a}`;
}

/** The nodes and links to draw while this source and this page are open. */
export function visibleGraph(index: MapIndex, open: Opened): VisibleGraph {
  const { map } = index;
  const drawAllPassages = map.passages.length <= PASSAGES_ALWAYS_DRAWN;
  const nodes: GraphNode[] = [];
  const links: GraphLink[] = [];

  for (const source of map.sources) {
    const key = nodeKey("source", source.id);
    nodes.push({
      kind: "source",
      id: source.id,
      key,
      label: source.title,
      sub: plural(source.passageCount, "passage"),
      radius: sourceRadius(source.passageCount),
      parent: null,
    });
    if (!drawAllPassages && open.sourceId !== source.id) continue;
    for (const passage of index.passagesBySource.get(source.id) ?? []) {
      const passageKey = nodeKey("passage", passage.id);
      nodes.push({
        kind: "passage",
        id: passage.id,
        key: passageKey,
        label: passage.label,
        sub: null,
        radius: PASSAGE_RADIUS,
        parent: key,
      });
      links.push({ key: `holds:${passage.id}`, kind: "holds", source: key, target: passageKey, weight: 1 });
    }
  }

  for (const page of map.pages) {
    nodes.push({
      kind: "page",
      id: page.route,
      key: nodeKey("page", page.route),
      label: page.label,
      sub: plural(page.controlCount, "control"),
      radius: pageRadius(page.controlCount),
      parent: null,
    });
  }

  for (const link of map.readLinks) {
    if (!index.sources.has(link.sourceId) || !index.pages.has(link.route)) continue;
    links.push({
      key: `read:${link.sourceId}:${link.route}`,
      kind: "read",
      source: nodeKey("source", link.sourceId),
      target: nodeKey("page", link.route),
      weight: link.passages,
    });
  }

  const moves = new Map<string, GraphLink>();
  for (const move of map.moves) {
    if (!index.pages.has(move.from) || !index.pages.has(move.to)) continue;
    const pair = pairKey(move.from, move.to);
    const drawn = moves.get(pair);
    if (drawn) {
      drawn.weight += move.count;
      continue;
    }
    const [first, second] = move.from < move.to ? [move.from, move.to] : [move.to, move.from];
    moves.set(pair, {
      key: `move:${pair}`,
      kind: "move",
      source: nodeKey("page", first),
      target: nodeKey("page", second),
      weight: move.count,
    });
  }
  links.push(...moves.values());

  if (open.route !== null && index.pages.has(open.route)) {
    const pageKey = nodeKey("page", open.route);
    const shown = new Set<string>();
    for (const control of index.controlsByRoute.get(open.route) ?? []) {
      const key = nodeKey("control", control.id);
      shown.add(control.id);
      nodes.push({
        kind: "control",
        id: control.id,
        key,
        label: control.name,
        sub: null,
        radius: CONTROL_RADIUS,
        parent: pageKey,
      });
      links.push({ key: `on:${control.id}`, kind: "on", source: pageKey, target: key, weight: 1 });
    }
    const drawn = new Set<string>();
    for (const link of map.controlLinks) {
      if (!shown.has(link.controlId)) continue;
      const from = nodeKey("control", link.controlId);
      if (link.revealsControlId && shown.has(link.revealsControlId)) {
        const key = `reveals:${link.controlId}:${link.revealsControlId}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        links.push({ key, kind: "reveals", source: from, target: nodeKey("control", link.revealsControlId), weight: 1 });
      } else if (link.toRoute && link.toRoute !== open.route && index.pages.has(link.toRoute)) {
        const key = `opens:${link.controlId}:${link.toRoute}`;
        if (drawn.has(key)) continue;
        drawn.add(key);
        links.push({ key, kind: "opens", source: from, target: nodeKey("page", link.toRoute), weight: 1 });
      }
    }
  }

  return { nodes, links };
}

/** What lights up with a node: the node, what it is linked to, and the lines between them. */
export type Lit = { nodes: Set<string>; links: Set<string> };

export function litBy(index: MapIndex, graph: VisibleGraph, focus: NodeRef | null): Lit | null {
  if (!focus) return null;
  const key = keyOf(focus);
  const nodes = new Set<string>([key]);
  const links = new Set<string>();
  for (const link of graph.links) {
    if (link.source !== key && link.target !== key) continue;
    links.add(link.key);
    nodes.add(link.source);
    nodes.add(link.target);
  }
  // A passage has no line of its own to the page it was read from: its source carries that
  // line, so the page and the source's line to it light up with the passage.
  if (focus.kind === "passage") {
    const passage = index.passages.get(focus.id);
    if (passage?.readFrom) {
      nodes.add(nodeKey("page", passage.readFrom));
      links.add(`read:${passage.sourceId}:${passage.readFrom}`);
    }
  }
  return { nodes, links };
}
