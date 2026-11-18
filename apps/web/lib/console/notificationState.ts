/**
 * The bell's bookkeeping, kept pure so it can be tested without a browser.
 *
 * Two questions, two answers:
 *
 * - Unread is per line, by id. A line is unread until the reader opens the bell or follows the
 *   line's own link. A timestamp watermark cannot do this: a pull request that lands with an older
 *   date than the last thing the reader saw would never count.
 * - A pop-up notice is for something that arrived while the reader was watching. The first list a
 *   page receives is what already existed, so it never pops; only a pull request that appears
 *   after that does, and only once per browser.
 */
import type { Notification } from "./notifications";

/** The ids the reader has opened, per browser. */
export const READ_KEY = "patchlet.notifications.read";
/** The ids a notice has already been shown for, per browser, so a reload never repeats one. */
export const ANNOUNCED_KEY = "patchlet.notifications.announced";
/** The old watermark: everything dated at or before it was read. Migrated once, then removed. */
export const LEGACY_SEEN_KEY = "patchlet.notifications.seen";

/** Enough to cover every line the bell can show many times over, small enough for storage. */
export const REMEMBERED_IDS = 200;

/** How many notices stand on screen at once. The rest wait their turn. */
export const VISIBLE_NOTICES = 3;
/** On a phone one notice already covers a third of the screen. */
export const VISIBLE_NOTICES_NARROW = 1;

/** Reads a stored id list, ignoring anything that is not one. */
export function parseIds(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

/** Adds ids to a remembered list, newest last, keeping only the most recent ones. */
export function remember(list: readonly string[], ids: readonly string[]): string[] {
  const fresh = ids.filter((id, index) => !list.includes(id) && ids.indexOf(id) === index);
  if (fresh.length === 0) return [...list];
  return [...list, ...fresh].slice(-REMEMBERED_IDS);
}

export function unreadCount(items: readonly Notification[], read: readonly string[]): number {
  const known = new Set(read);
  return items.filter((item) => !known.has(item.id)).length;
}

export function isUnread(item: Notification, read: readonly string[]): boolean {
  return !read.includes(item.id);
}

/**
 * The read list for a browser that only has the old watermark: every line dated at or before it
 * was on screen when the reader last opened the bell.
 */
export function migrateLegacySeen(items: readonly Notification[], seen: string): string[] {
  const watermark = Date.parse(seen);
  if (Number.isNaN(watermark)) return [];
  return items.filter((item) => Date.parse(item.at) <= watermark).map((item) => item.id);
}

/**
 * The pull requests in `next` that deserve a notice: new since the page's first list (`known`)
 * and never announced in this browser. With no first list yet, nothing is new.
 */
export function arrivedPullRequests(
  known: ReadonlySet<string> | null,
  next: readonly Notification[],
  announced: readonly string[],
): Notification[] {
  if (known === null) return [];
  const shown = new Set(announced);
  return next.filter(
    (item) => item.kind === "pull_request" && !known.has(item.id) && !shown.has(item.id),
  );
}

/** Puts new notices in front of the waiting ones, newest first, each once. */
export function enqueueNotices(
  current: readonly Notification[],
  incoming: readonly Notification[],
): Notification[] {
  const ids = new Set(current.map((item) => item.id));
  const fresh = incoming.filter((item) => !ids.has(item.id));
  return [...fresh, ...current];
}

/** Where a request lives in the console. */
export function activityHref(groupId: string): string {
  return `/console/activity?request=${encodeURIComponent(groupId)}`;
}

/** The notice's one-line headline for a pull request. */
export function noticeHeadline(item: Notification): string {
  const number = item.number === null ? "" : ` #${item.number}`;
  return `Draft pull request${number} is ready for review`;
}
