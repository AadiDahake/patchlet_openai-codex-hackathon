"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { Notification } from "@/lib/console/notifications";
import {
  ANNOUNCED_KEY,
  LEGACY_SEEN_KEY,
  READ_KEY,
  arrivedPullRequests,
  enqueueNotices,
  migrateLegacySeen,
  parseIds,
  remember,
  unreadCount,
} from "@/lib/console/notificationState";

/** How long to wait before reopening a feed the browser gave up on (a 401, a failed deploy). */
const REOPEN_MS = 30_000;

type NotificationsValue = {
  /** What the agent opened on GitHub, newest first. */
  items: Notification[];
  /** Ids the reader has opened, in this browser. */
  read: string[];
  unread: number;
  /** Pull requests that arrived while the console was open and still owe the reader a notice. */
  notices: Notification[];
  /** Goes up every time the list changes, so a page can re-read what it shows. */
  revision: number;
  markRead: (ids: string[]) => void;
  dismissNotice: (id: string) => void;
};

const NotificationsContext = createContext<NotificationsValue>({
  items: [],
  read: [],
  unread: 0,
  notices: [],
  revision: 0,
  markRead: () => {},
  dismissNotice: () => {},
});

export function useNotifications(): NotificationsValue {
  return useContext(NotificationsContext);
}

function load(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function save(key: string, ids: string[]): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(ids));
  } catch {
    // A browser with storage turned off counts everything as unread and may repeat a notice.
  }
}

function forget(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing to do: the key simply stays.
  }
}

function parseFrame(data: string): Notification[] | null {
  try {
    const body = JSON.parse(data) as { notifications?: unknown };
    return Array.isArray(body.notifications) ? (body.notifications as Notification[]) : null;
  } catch {
    return null;
  }
}

/**
 * One live feed of what the agent opened on GitHub, for every console page.
 *
 * It sits in the console layout, so it survives moving between pages: the stream stays open, the
 * first list it received stays the baseline, and a pull request is announced once wherever the
 * reader happens to be.
 */
export function NotificationsProvider({ children }: { children: React.ReactNode }) {
  const [items, setItems] = useState<Notification[]>([]);
  // Storage is read once at mount. The list itself arrives from the stream afterwards, so the
  // first render agrees with the server either way.
  const [read, setRead] = useState<string[]>(() =>
    typeof window === "undefined" ? [] : parseIds(load(READ_KEY)),
  );
  const [notices, setNotices] = useState<Notification[]>([]);
  const [revision, setRevision] = useState(0);
  // The ids that existed when this page first heard from the server; null until then.
  const known = useRef<Set<string> | null>(null);

  const receive = useCallback((list: Notification[]) => {
    if (known.current === null) {
      known.current = new Set(list.map((item) => item.id));
      const legacy = load(LEGACY_SEEN_KEY);
      if (legacy !== null) {
        const migrated = remember(parseIds(load(READ_KEY)), migrateLegacySeen(list, legacy));
        save(READ_KEY, migrated);
        forget(LEGACY_SEEN_KEY);
        setRead(migrated);
      }
    } else {
      const arrived = arrivedPullRequests(known.current, list, parseIds(load(ANNOUNCED_KEY)));
      for (const item of list) known.current.add(item.id);
      if (arrived.length > 0) {
        // Written before it is shown, so another tab or a reload never shows it a second time.
        save(ANNOUNCED_KEY, remember(parseIds(load(ANNOUNCED_KEY)), arrived.map((item) => item.id)));
        setNotices((current) => enqueueNotices(current, arrived));
      }
    }
    setItems(list);
    setRevision((value) => value + 1);
  }, []);

  useEffect(() => {
    let source: EventSource | null = null;
    let reopen: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const open = () => {
      source = new EventSource("/api/notifications/stream");
      source.addEventListener("notifications", (message) => {
        const list = parseFrame((message as MessageEvent<string>).data);
        if (list) receive(list);
      });
      source.addEventListener("error", () => {
        // EventSource retries a dropped connection by itself; it only gives up on a response
        // that is not a stream at all. Try again later rather than going quiet for good.
        if (stopped || source?.readyState !== EventSource.CLOSED) return;
        source.close();
        reopen = setTimeout(open, REOPEN_MS);
      });
    };

    open();
    return () => {
      stopped = true;
      source?.close();
      clearTimeout(reopen);
    };
  }, [receive]);

  // Another tab opening the bell clears the count here too.
  useEffect(() => {
    const onStorage = (event: StorageEvent): void => {
      if (event.key === READ_KEY) setRead(parseIds(event.newValue));
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const markRead = useCallback((ids: string[]) => {
    if (ids.length === 0) return;
    // Merged with storage rather than state, so a read in another tab is never lost.
    const next = remember(parseIds(load(READ_KEY)), ids);
    save(READ_KEY, next);
    setRead(next);
    // A notice for something the reader has now opened has done its job.
    setNotices((current) => current.filter((item) => !ids.includes(item.id)));
  }, []);

  const dismissNotice = useCallback((id: string) => {
    setNotices((current) => current.filter((item) => item.id !== id));
  }, []);

  const value = useMemo<NotificationsValue>(
    () => ({
      items,
      read,
      unread: unreadCount(items, read),
      notices,
      revision,
      markRead,
      dismissNotice,
    }),
    [items, read, notices, revision, markRead, dismissNotice],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}
