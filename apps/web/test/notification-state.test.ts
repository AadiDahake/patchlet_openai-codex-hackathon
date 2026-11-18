import { describe, expect, it } from "vitest";
import type { Notification } from "@/lib/console/notifications";
import {
  REMEMBERED_IDS,
  activityHref,
  arrivedPullRequests,
  enqueueNotices,
  isUnread,
  migrateLegacySeen,
  noticeHeadline,
  parseIds,
  remember,
  unreadCount,
} from "@/lib/console/notificationState";

function item(over: Partial<Notification> = {}): Notification {
  return {
    id: "g1:pull_request:57",
    groupId: "g1",
    kind: "pull_request",
    number: 57,
    url: "https://github.com/acme/app/pull/57",
    title: "Choose a seat while booking",
    status: "pr_open",
    reportCount: 4,
    userReportCount: 2,
    at: "2026-11-18T09:20:00Z",
    ...over,
  };
}

const issue = item({ id: "g1:issue:41", kind: "issue", number: 41, at: "2026-11-18T08:45:00Z" });
const pull = item();

describe("parseIds", () => {
  it("reads a stored list and drops anything that is not an id", () => {
    expect(parseIds('["a", 2, "b", null]')).toEqual(["a", "b"]);
  });

  it("treats missing or broken storage as nothing read", () => {
    expect(parseIds(null)).toEqual([]);
    expect(parseIds("{not json")).toEqual([]);
    expect(parseIds('{"a":1}')).toEqual([]);
  });
});

describe("remember", () => {
  it("adds each new id once, after the ones already there", () => {
    expect(remember(["a"], ["b", "a", "b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("keeps only the most recent ids", () => {
    const old = Array.from({ length: REMEMBERED_IDS }, (_, index) => `old-${index}`);
    const next = remember(old, ["new"]);
    expect(next).toHaveLength(REMEMBERED_IDS);
    expect(next[0]).toBe("old-1");
    expect(next.at(-1)).toBe("new");
  });
});

describe("unread", () => {
  it("counts every line the reader has not opened", () => {
    expect(unreadCount([pull, issue], [])).toBe(2);
    expect(unreadCount([pull, issue], [issue.id])).toBe(1);
    expect(isUnread(pull, [issue.id])).toBe(true);
  });

  it("counts a pull request dated before the last thing the reader saw", () => {
    // The old watermark compared dates, so this pull request never counted.
    const late = item({ at: "2026-11-18T08:00:00Z" });
    expect(unreadCount([issue, late], [issue.id])).toBe(1);
  });
});

describe("migrateLegacySeen", () => {
  it("marks what was dated at or before the old watermark as read", () => {
    expect(migrateLegacySeen([pull, issue], "2026-11-18T09:00:00Z")).toEqual([issue.id]);
    expect(migrateLegacySeen([pull, issue], "2026-11-18T09:20:00.000Z")).toEqual([pull.id, issue.id]);
  });

  it("migrates nothing from a value that is not a date", () => {
    expect(migrateLegacySeen([pull, issue], "")).toEqual([]);
  });
});

describe("arrivedPullRequests", () => {
  it("announces nothing from the first list a page receives", () => {
    expect(arrivedPullRequests(null, [pull, issue], [])).toEqual([]);
  });

  it("announces a pull request that appears after the first list", () => {
    expect(arrivedPullRequests(new Set([issue.id]), [pull, issue], [])).toEqual([pull]);
  });

  it("never announces an issue", () => {
    expect(arrivedPullRequests(new Set(), [issue], [])).toEqual([]);
  });

  it("never announces the same pull request twice in one browser", () => {
    expect(arrivedPullRequests(new Set([issue.id]), [pull, issue], [pull.id])).toEqual([]);
  });

  it("announces each of several pull requests that land together", () => {
    const other = item({ id: "g2:pull_request:58", groupId: "g2", number: 58 });
    expect(arrivedPullRequests(new Set(), [other, pull], [])).toEqual([other, pull]);
  });
});

describe("enqueueNotices", () => {
  it("puts the newest in front and never queues one twice", () => {
    const other = item({ id: "g2:pull_request:58" });
    expect(enqueueNotices([pull], [other, pull]).map((notice) => notice.id)).toEqual([
      other.id,
      pull.id,
    ]);
  });
});

describe("notice text", () => {
  it("names the pull request and links its request on Activity", () => {
    expect(noticeHeadline(pull)).toBe("Draft pull request #57 is ready for review");
    expect(noticeHeadline(item({ number: null }))).toBe("Draft pull request is ready for review");
    expect(activityHref("a b")).toBe("/console/activity?request=a%20b");
  });
});
