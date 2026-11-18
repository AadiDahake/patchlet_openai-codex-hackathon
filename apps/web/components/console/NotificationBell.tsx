"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { formatRelativeTime, reportCountLabel } from "@/lib/console/format";
import { isUnread } from "@/lib/console/notificationState";
import { useNotifications } from "./NotificationsProvider";

/** Issues and pull requests the worker opened, newest first, with an unread count. */
export function NotificationBell() {
  const { items, read, unread, markRead } = useNotifications();
  const [open, setOpen] = useState(false);
  // What was unread at the moment the reader opened the list, so it can still say "New" while
  // it is open even though opening it marked everything read.
  const [fresh, setFresh] = useState<string[]>([]);
  const root = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent): void => {
      if (root.current && !root.current.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const toggle = useCallback(() => {
    if (open) {
      setOpen(false);
      return;
    }
    setFresh(items.filter((item) => isUnread(item, read)).map((item) => item.id));
    markRead(items.map((item) => item.id));
    setOpen(true);
  }, [open, items, read, markRead]);

  return (
    <div className="bell" ref={root}>
      <button
        type="button"
        className={`bell__trigger${open ? " is-open" : ""}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={
          unread === 0
            ? "What the agent opened on GitHub"
            : `What the agent opened on GitHub, ${unread} new`
        }
        onClick={toggle}
      >
        <BellGlyph />
        {/* Keyed by the count, so each rise replays the badge's entrance. */}
        {unread > 0 ? (
          <span key={unread} className="bell__count">
            {unread}
          </span>
        ) : null}
      </button>

      {open ? (
        <div className="bell__menu" role="menu">
          <div className="bell__head">On GitHub</div>
          {items.length === 0 ? (
            <p className="bell__empty">No requests filed yet.</p>
          ) : (
            <ul className="bell__list">
              {items.map((item) => {
                const isNew = fresh.includes(item.id);
                return (
                  <li key={item.id}>
                    <a
                      className={`bell__item${isNew ? " is-new" : ""}`}
                      href={item.url}
                      target="_blank"
                      rel="noreferrer"
                      role="menuitem"
                    >
                      <span className="bell__item-title">{item.title}</span>
                      <span className="bell__item-meta">
                        {isNew ? <span className="bell__item-new">New</span> : null}
                        {item.kind === "issue" ? "Issue" : "Pull request"}
                        {item.number === null ? "" : ` #${item.number}`}
                        {` · ${reportCountLabel(item.reportCount, item.userReportCount).toLowerCase()}`}
                        {item.at ? ` · ${formatRelativeTime(item.at)}` : ""}
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      ) : null}
    </div>
  );
}

function BellGlyph() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M6 9a6 6 0 1 1 12 0c0 3.2.7 5 1.5 6H4.5C5.3 14 6 12.2 6 9Z"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M9.7 18a2.4 2.4 0 0 0 4.6 0" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}
