/**
 * Reading a stored address: what to show for it, and which product page it is.
 *
 * A source keeps the address it was read from, and that address is sometimes a developer's own
 * machine. A loopback host says nothing to the person reading the console, so it is never shown:
 * the path is what identifies the page.
 */
import { routeOf } from "@patchlet/shared";

const LOOPBACK = /^(localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[::1\]|.+\.localhost|.+\.local)$/i;

function parse(address: string): URL | null {
  if (!/^https?:\/\//i.test(address)) return null;
  try {
    return new URL(address);
  } catch {
    return null;
  }
}

function tidyPath(pathname: string): string {
  return pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
}

/**
 * An address as the console shows it: host and path for a public page, the path alone for a
 * loopback one. Anything that is not a web address (a file name) is shown as it is.
 */
export function displayAddress(address: string | null | undefined): string | null {
  const raw = address?.trim();
  if (!raw) return null;
  const url = parse(raw);
  if (!url) return raw;
  const path = tidyPath(url.pathname);
  if (LOOPBACK.test(url.hostname)) return path;
  return path === "/" ? url.host : `${url.host}${path}`;
}

/** A page of the product, by the two things that identify it: where it is served and its route. */
export type KnownPage = { route: string; url: string };

/**
 * The product page an address is, or null.
 *
 * Two things must agree: the origin and the route. The same path on another origin is another
 * copy of the product (a preview build, a laptop), and the map only speaks for the site the
 * project names (`belongsToSite` in `lib/graph/origin.ts`), so that address is not this page.
 */
export function pageForAddress(address: string | null | undefined, pages: readonly KnownPage[]): string | null {
  const url = address ? parse(address.trim()) : null;
  if (!url) return null;
  const route = routeOf(url.toString());
  for (const page of pages) {
    if (page.route !== route) continue;
    const pageUrl = parse(page.url);
    if (pageUrl && pageUrl.origin === url.origin) return page.route;
  }
  return null;
}
