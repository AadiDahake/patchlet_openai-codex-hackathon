"use client";

import Link from "next/link";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Notification } from "@/lib/console/notifications";
import { reportCountLabel } from "@/lib/console/format";
import {
  VISIBLE_NOTICES,
  VISIBLE_NOTICES_NARROW,
  activityHref,
  noticeHeadline,
} from "@/lib/console/notificationState";
import { useNotifications } from "./NotificationsProvider";

/** Long enough to read twice; it never runs while the pointer or focus is on the notice. */
const DISMISS_AFTER_MS = 15_000;
/** Matches the exit transition in globals.css (`.pr-notice.is-leaving`). */
const EXIT_MS = 180;
const SETTLE_EASING = "cubic-bezier(0.22, 1, 0.36, 1)";

/** The console's small breakpoint, where the bar folds its tabs into a menu. */
const NARROW = "(max-width: 768px)";

function subscribeNarrow(onChange: () => void): () => void {
  const query = window.matchMedia(NARROW);
  query.addEventListener("change", onChange);
  return () => query.removeEventListener("change", onChange);
}

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/**
 * The pull requests that arrived while the reader was in the console, as notices under the bell.
 *
 * At most three stand at once on a wide screen and one on a phone, newest on top; the rest wait
 * for one to go. They float over the page and take no room in it, so nothing below moves when
 * one appears.
 */
export function PullRequestNotices() {
  const { notices } = useNotifications();
  const narrow = useSyncExternalStore(
    subscribeNarrow,
    () => window.matchMedia(NARROW).matches,
    () => false,
  );
  const visible = notices.slice(0, narrow ? VISIBLE_NOTICES_NARROW : VISIBLE_NOTICES);
  const waiting = notices.length - visible.length;

  // When one notice leaves, the ones below slide up into its place rather than jumping (FLIP,
  // on transform only).
  const nodes = useRef(new Map<string, HTMLElement>());
  const tops = useRef(new Map<string, number>());
  const visibleKey = visible.map((item) => item.id).join(" ");

  useLayoutEffect(() => {
    const reduce = prefersReducedMotion();
    const next = new Map<string, number>();
    for (const [id, node] of nodes.current) {
      const top = node.getBoundingClientRect().top;
      const before = tops.current.get(id);
      if (!reduce && before !== undefined && Math.abs(before - top) > 0.5) {
        node.animate([{ transform: `translateY(${before - top}px)` }, { transform: "none" }], {
          duration: 280,
          easing: SETTLE_EASING,
        });
      }
      next.set(id, top);
    }
    tops.current = next;
  }, [visibleKey]);

  const register = useCallback((id: string, node: HTMLElement | null) => {
    if (node) nodes.current.set(id, node);
    else nodes.current.delete(id);
  }, []);

  return (
    <div className="pr-notices" aria-live="polite" aria-relevant="additions">
      {visible.map((item) => (
        <PullRequestNotice key={item.id} item={item} register={register} />
      ))}
      {waiting > 0 ? (
        <p className="pr-notices__more">
          {waiting} more {waiting === 1 ? "pull request" : "pull requests"} in the bell
        </p>
      ) : null}
    </div>
  );
}

function PullRequestNotice({
  item,
  register,
}: {
  item: Notification;
  register: (id: string, node: HTMLElement | null) => void;
}) {
  const { markRead, dismissNotice } = useNotifications();
  const { id } = item;
  // Both stable for the notice's life, so the dismiss timer is not restarted by unrelated renders.
  const onDismiss = useCallback(() => dismissNotice(id), [dismissNotice, id]);
  const onOpen = useCallback(() => markRead([id]), [markRead, id]);
  const [leaving, setLeaving] = useState(false);
  const [held, setHeld] = useState(false);
  const [hidden, setHidden] = useState(() => typeof document !== "undefined" && document.hidden);
  const headingId = `pr-notice-${item.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`;

  // The exit plays first, then the notice is removed; `then` says what removing it means.
  const leave = useCallback((then: () => void) => {
    setLeaving(true);
    window.setTimeout(then, EXIT_MS);
  }, []);

  // A notice that times out while the tab is in the background would never have been seen.
  useEffect(() => {
    const onVisibility = (): void => setHidden(document.hidden);
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

  useEffect(() => {
    if (held || hidden || leaving) return;
    const timer = window.setTimeout(() => leave(onDismiss), DISMISS_AFTER_MS);
    return () => window.clearTimeout(timer);
  }, [held, hidden, leaving, leave, onDismiss]);

  return (
    <article
      ref={(node) => register(item.id, node)}
      className={`pr-notice${leaving ? " is-leaving" : ""}`}
      aria-labelledby={headingId}
      onPointerEnter={() => setHeld(true)}
      onPointerLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setHeld(false);
      }}
    >
      <span className="pr-notice__glyph" aria-hidden="true">
        <PullRequestGlyph />
      </span>
      <div className="pr-notice__body">
        <p className="pr-notice__headline" id={headingId}>
          {noticeHeadline(item)}
        </p>
        <p className="pr-notice__title">{item.title}</p>
        <p className="pr-notice__meta">
          {reportCountLabel(item.reportCount, item.userReportCount)}
        </p>
      </div>
      <div className="pr-notice__actions">
        <a
          className="pr-notice__primary"
          href={item.url}
          target="_blank"
          rel="noreferrer"
          onClick={() => leave(onOpen)}
        >
          View pull request
          <span aria-hidden="true">&#8599;</span>
        </a>
        <Link
          className="pr-notice__secondary"
          href={activityHref(item.groupId)}
          onClick={() => leave(onOpen)}
        >
          Open in Activity
        </Link>
      </div>
      <button
        type="button"
        className="pr-notice__close"
        aria-label={`Dismiss the notice for ${item.title}`}
        onClick={() => leave(onDismiss)}
      >
        <CloseGlyph />
      </button>
    </article>
  );
}

function PullRequestGlyph() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
      <circle cx="6" cy="6" r="2.4" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="6" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="18" cy="18" r="2.4" stroke="currentColor" strokeWidth="1.8" />
      <path d="M6 8.4v7.2" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      <path
        d="M18 15.6V10a3 3 0 0 0-3-3h-4.5m0 0 2.4-2.4M10.5 7l2.4 2.4"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseGlyph() {
  return (
    <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}
