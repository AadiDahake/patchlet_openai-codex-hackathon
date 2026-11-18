/**
 * What the Knowledge page draws: everything the agent knows about one project, as nodes and the
 * links the stored rows hold between them.
 *
 * Nothing here is inferred. A source owns a passage because the chunk row names its document, a
 * page leads to a page because a transition row says a control on one opened the other, and a
 * source is tied to a page only when a passage's stored address is that page's own address.
 */

/** A knowledge source: one `document` row. */
export type MapSource = {
  id: string;
  title: string;
  /** `upload`, `url` or `text`, as stored. */
  kind: string;
  status: string;
  /** Where it was read from, ready to show: never a loopback host. Null for a written note. */
  address: string | null;
  /** The count the Knowledge page states for this source. */
  passageCount: number;
  pageCount: number | null;
  meanConfidence: number | null;
};

/** One passage: one `chunk` row, without its embedding. */
export type MapPassage = {
  id: string;
  sourceId: string;
  /** The heading it sits under, or its first words when it has none. */
  label: string;
  text: string;
  /** Page number inside the source, for a paged file. */
  page: number | null;
  /** How well the reader read it, 0 to 1. Null when the text was never scanned. */
  confidence: number | null;
  /** Route of the product page this passage was read from, when the stored address is that page. */
  readFrom: string | null;
};

/** One page of the product: one `site_page` row. */
export type MapPage = {
  route: string;
  title: string;
  /** The title without the site name every page repeats, or the route when there is no title. */
  label: string;
  controlCount: number;
};

/** One control on a page: one `affordance` row. */
export type MapControl = {
  id: string;
  route: string;
  role: string;
  name: string;
  landmark: string | null;
  /** Where a link points, ready to show. */
  href: string | null;
};

/** Pressing controls on one page opened another: the `transition` rows between two pages. */
export type MapMove = {
  from: string;
  to: string;
  /** How many transition rows this stands for. */
  count: number;
};

/** One transition row, from the control's side: what pressing it did. */
export type MapControlLink = {
  controlId: string;
  /** The page it opened, for a navigation. */
  toRoute: string | null;
  /** The control it revealed on the same page, for a reveal. */
  revealsControlId: string | null;
};

/** A source was read from a page: at least one of its passages carries that page's address. */
export type MapReadLink = {
  sourceId: string;
  route: string;
  passages: number;
};

/** The numbers the Knowledge and Product map pages state, computed the way they compute them. */
export type MapTotals = {
  sources: number;
  passages: number;
  pages: number;
  controls: number;
  transitions: number;
};

export type KnowledgeMap = {
  sources: MapSource[];
  passages: MapPassage[];
  pages: MapPage[];
  controls: MapControl[];
  moves: MapMove[];
  controlLinks: MapControlLink[];
  readLinks: MapReadLink[];
  totals: MapTotals;
};

/** One passage placed on the plane. Both coordinates are inside -1 to 1. */
export type VectorPoint = { id: string; x: number; y: number };

/** The vector store as a picture: where each passage lands, and how much the picture keeps. */
export type VectorLayout = {
  points: VectorPoint[];
  /** Each passage and one of its nearest passages by cosine similarity, as indexes into `points`. */
  links: [number, number][];
  /** How many nearest passages each passage is tied to. */
  neighbours: number;
  /** Length of the stored vectors. Zero when there are none. */
  dimensions: number;
  /** Share of every passage's nearest passages that are still its nearest on the picture, 0 to 1. */
  kept: number;
  /** Every passage the project has. More than `points.length` when the store is over the limit. */
  total: number;
};

/** A passage near another one, by cosine similarity in pgvector. */
export type NearPassage = { id: string; similarity: number };
