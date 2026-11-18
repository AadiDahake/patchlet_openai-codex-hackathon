/**
 * The words a node carries on the picture.
 *
 * A label is always something a person wrote: a document title, a heading, a page title. It is
 * never an address, and it is short enough to sit beside a dot.
 */

/** Longest label drawn beside a node before it is cut. */
export const LABEL_LIMIT = 34;

// The en dash and the em dash are written as escapes: they are data to match, never prose.
const SEPARATORS = [" | ", " \u00b7 ", " - ", " \u2013 ", " \u2014 ", " : "];

function flat(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** Cuts at a word where it can, and says that it cut. */
export function clip(text: string, limit = LABEL_LIMIT): string {
  const value = flat(text);
  if (value.length <= limit) return value;
  const cut = value.slice(0, limit - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > limit * 0.6 ? cut.slice(0, space) : cut).trimEnd()}\u2026`;
}

/** What a passage is called: its heading, or how it starts. */
export function passageLabel(heading: string | null | undefined, content: string): string {
  const named = heading ? flat(heading) : "";
  if (named) return clip(named);
  const start = flat(content.replace(/^[#>*\-\s]+/, ""));
  return start ? clip(start) : "Untitled passage";
}

function lastSegment(title: string): { head: string; tail: string } | null {
  let best: { head: string; tail: string } | null = null;
  for (const separator of SEPARATORS) {
    const at = title.lastIndexOf(separator);
    if (at <= 0) continue;
    const tail = title.slice(at + separator.length).trim();
    const head = title.slice(0, at).trim();
    if (!tail || !head) continue;
    // The shortest tail is the outermost segment, whichever separator wrote it.
    if (!best || tail.length < best.tail.length) best = { head, tail };
  }
  return best;
}

/**
 * The site name most page titles end with ("Check-in | NovaAir"), or null when they do not share
 * one. Half of the titled pages, and at least two of them, must agree.
 */
export function sharedSiteName(titles: readonly string[]): string | null {
  const tally = new Map<string, number>();
  let titled = 0;
  for (const raw of titles) {
    const title = flat(raw);
    if (!title) continue;
    titled += 1;
    const tail = lastSegment(title)?.tail;
    if (tail) tally.set(tail, (tally.get(tail) ?? 0) + 1);
  }
  let name: string | null = null;
  let most = 0;
  for (const [tail, count] of tally) {
    if (count > most) {
      name = tail;
      most = count;
    }
  }
  return name !== null && most >= 2 && most * 2 >= titled ? name : null;
}

/** What a page is called: its title without the shared site name, or its route when untitled. */
export function pageLabel(title: string, route: string, siteName: string | null): string {
  const value = flat(title);
  if (!value) return route;
  const parts = siteName ? lastSegment(value) : null;
  return clip(parts && parts.tail === siteName ? parts.head : value);
}
