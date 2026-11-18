/**
 * Finding a node by what it says. Every word of the query has to be there; a match in a node's
 * name ranks above a match in a passage's text, and the earlier in the name the better.
 */
import { plural, type MapIndex, type NodeRef } from "./graph";

export type SearchHit = NodeRef & {
  label: string;
  /** Where the node sits, or the words around the match when the match is in a passage's text. */
  context: string;
};

/** How much of a passage is shown around the word that matched. */
const EXCERPT = 72;

const KIND_RANK: Record<NodeRef["kind"], number> = { source: 0, page: 1, passage: 2, control: 3 };

function words(query: string): string[] {
  return query.toLowerCase().split(/\s+/).filter(Boolean);
}

/** Lower is better. Null when a word is missing from both the name and the text. */
function score(tokens: readonly string[], name: string, text: string): number | null {
  let total = 0;
  for (const token of tokens) {
    const at = name.indexOf(token);
    if (at === 0) total += 0;
    else if (at > 0 && /\W/.test(name[at - 1] ?? "")) total += 1;
    else if (at > 0) total += 2;
    else if (text.includes(token)) total += 4;
    else return null;
  }
  return total;
}

/** The words around the first query word found in a passage, on one line. */
export function excerpt(text: string, tokens: readonly string[]): string {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  for (const token of tokens) {
    const found = lower.indexOf(token);
    if (found !== -1 && (at === -1 || found < at)) at = found;
  }
  if (at === -1 || flat.length <= EXCERPT) return flat.slice(0, EXCERPT);
  const start = Math.max(0, Math.min(at - 24, flat.length - EXCERPT));
  const piece = flat.slice(start, start + EXCERPT).trim();
  return `${start > 0 ? "…" : ""}${piece}${start + EXCERPT < flat.length ? "…" : ""}`;
}

/** The best matches for a query, at most `limit` of them. An empty query matches nothing. */
export function searchNodes(index: MapIndex, query: string, limit = 8): SearchHit[] {
  const tokens = words(query);
  if (tokens.length === 0) return [];
  const found: { hit: SearchHit; score: number; order: number }[] = [];
  let order = 0;
  const consider = (hit: SearchHit, text: string): void => {
    const rank = score(tokens, hit.label.toLowerCase(), text.toLowerCase());
    if (rank !== null) found.push({ hit, score: rank, order: order++ });
  };

  for (const source of index.map.sources) {
    consider(
      { kind: "source", id: source.id, label: source.title, context: plural(source.passageCount, "passage") },
      source.address ?? "",
    );
  }
  for (const page of index.map.pages) {
    consider({ kind: "page", id: page.route, label: page.label, context: page.route }, `${page.title} ${page.route}`);
  }
  for (const passage of index.map.passages) {
    const title = index.sources.get(passage.sourceId)?.title ?? "";
    const inName = score(tokens, passage.label.toLowerCase(), "") !== null;
    consider(
      {
        kind: "passage",
        id: passage.id,
        label: passage.label,
        context: inName ? title : excerpt(passage.text, tokens),
      },
      passage.text,
    );
  }
  for (const control of index.map.controls) {
    const page = index.pages.get(control.route);
    consider(
      {
        kind: "control",
        id: control.id,
        label: control.name,
        context: `${control.role} on ${page?.label ?? control.route}`,
      },
      control.role,
    );
  }

  return found
    .sort((a, b) => a.score - b.score || KIND_RANK[a.hit.kind] - KIND_RANK[b.hit.kind] || a.order - b.order)
    .slice(0, limit)
    .map((entry) => entry.hit);
}
