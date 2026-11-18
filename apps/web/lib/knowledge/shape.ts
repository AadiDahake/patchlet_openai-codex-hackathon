/**
 * Stored rows in, the picture's nodes and links out. Pure: no database, no clock.
 *
 * Every link is read off a row. The one decision made here is what a transition draws as: the
 * 191 rows of a site whose header links everywhere would be 191 lines between fifteen pages, so
 * the rows between two pages are one move with a count, and the rows of one control are kept
 * for the moment its page is opened.
 */
import type { ConsoleDocument } from "../ingest/types";
import type { StoredGraph } from "../graph/store";
import { displayAddress, pageForAddress } from "./address";
import { pageLabel, passageLabel, sharedSiteName } from "./labels";
import type {
  KnowledgeMap,
  MapControl,
  MapControlLink,
  MapMove,
  MapPage,
  MapPassage,
  MapReadLink,
  MapSource,
} from "./types";

/** A `chunk` row, as the loader reads it. */
export type PassageRow = {
  id: string;
  documentId: string;
  ordinal: number;
  heading: string | null;
  content: string;
  page: number | null;
  confidence: number | null;
  sourceRef: string | null;
};

type Input = {
  documents: readonly ConsoleDocument[];
  passages: readonly PassageRow[];
  graph: StoredGraph;
};

/** Joins a page and a control key the way the graph identifies a control. */
const controlAt = (route: string, key: string): string => `${route}\n${key}`;

/** A control's node id: its row id, or its identity on the page when a row came without one. */
const controlIdOf = (control: StoredGraph["controls"][number]): string =>
  control.id || controlAt(control.route, control.key);

function toSources(documents: readonly ConsoleDocument[]): MapSource[] {
  return documents.map((document) => ({
    id: document.id,
    title: document.title.trim() || "Untitled source",
    kind: document.sourceKind,
    status: document.status,
    address: displayAddress(document.sourceRef),
    passageCount: document.chunkCount,
    pageCount: document.pageCount,
    meanConfidence: document.meanConfidence,
  }));
}

function toPages(graph: StoredGraph): MapPage[] {
  const siteName = sharedSiteName(graph.pages.map((page) => page.title));
  const controls = new Map<string, number>();
  for (const control of graph.controls) controls.set(control.route, (controls.get(control.route) ?? 0) + 1);
  return graph.pages.map((page) => ({
    route: page.route,
    title: page.title.trim(),
    label: pageLabel(page.title, page.route, siteName),
    controlCount: controls.get(page.route) ?? 0,
  }));
}

function toControls(graph: StoredGraph): MapControl[] {
  return graph.controls.map((control) => ({
    id: controlIdOf(control),
    route: control.route,
    role: control.role,
    name: control.name,
    landmark: control.landmark ?? null,
    href: displayAddress(control.href),
  }));
}

/** The transition rows, once per pair of pages for the picture and once per control for a page. */
function toMoves(graph: StoredGraph): { moves: MapMove[]; controlLinks: MapControlLink[] } {
  const routes = new Set(graph.pages.map((page) => page.route));
  const controlIds = new Map(
    graph.controls.map((control) => [controlAt(control.route, control.key), controlIdOf(control)]),
  );
  const moves = new Map<string, MapMove>();
  const controlLinks: MapControlLink[] = [];

  for (const transition of graph.transitions) {
    if (!routes.has(transition.from) || !routes.has(transition.to)) continue;
    const controlId = controlIds.get(controlAt(transition.from, transition.key));

    if (transition.kind === "reveal") {
      const revealed = transition.reveals ? controlIds.get(controlAt(transition.to, transition.reveals)) : undefined;
      if (controlId && revealed) controlLinks.push({ controlId, toRoute: null, revealsControlId: revealed });
      continue;
    }

    if (controlId) controlLinks.push({ controlId, toRoute: transition.to, revealsControlId: null });
    // A control that reloads its own page is a transition, and it is counted, but there is no
    // second page to draw a line to.
    if (transition.from === transition.to) continue;
    const pair = `${transition.from}\n${transition.to}`;
    const move = moves.get(pair);
    if (move) move.count += 1;
    else moves.set(pair, { from: transition.from, to: transition.to, count: 1 });
  }
  return { moves: [...moves.values()], controlLinks };
}

/**
 * Passages, and the pages their sources were read from.
 *
 * A passage of a crawled site carries the address of the page it came from; a passage of a
 * single article carries none of its own and the document's address stands for it.
 */
function toPassages(input: Input): { passages: MapPassage[]; readLinks: MapReadLink[] } {
  const documents = new Map(input.documents.map((document) => [document.id, document]));
  const readLinks = new Map<string, MapReadLink>();
  const passages: MapPassage[] = [];

  for (const row of input.passages) {
    const document = documents.get(row.documentId);
    // A passage whose source row is gone has nothing to hang from.
    if (!document) continue;
    const readFrom = pageForAddress(row.sourceRef ?? document.sourceRef, input.graph.pages);
    if (readFrom) {
      const pair = `${document.id}\n${readFrom}`;
      const link = readLinks.get(pair);
      if (link) link.passages += 1;
      else readLinks.set(pair, { sourceId: document.id, route: readFrom, passages: 1 });
    }
    passages.push({
      id: row.id,
      sourceId: document.id,
      label: passageLabel(row.heading, row.content),
      text: row.content,
      page: row.page,
      confidence: row.confidence,
      readFrom,
    });
  }
  return { passages, readLinks: [...readLinks.values()] };
}

/** The whole picture for one project. */
export function shapeKnowledgeMap(input: Input): KnowledgeMap {
  const { passages, readLinks } = toPassages(input);
  const { moves, controlLinks } = toMoves(input.graph);
  return {
    sources: toSources(input.documents),
    passages,
    pages: toPages(input.graph),
    controls: toControls(input.graph),
    moves,
    controlLinks,
    readLinks,
    totals: {
      sources: input.documents.length,
      // The Knowledge page states the sum of each source's own count, so this does too.
      passages: input.documents.reduce((total, document) => total + document.chunkCount, 0),
      pages: input.graph.pages.length,
      controls: input.graph.controls.length,
      transitions: input.graph.transitions.length,
    },
  };
}
