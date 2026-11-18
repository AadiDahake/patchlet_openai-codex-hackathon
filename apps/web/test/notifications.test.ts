import { describe, expect, it } from "vitest";
import { toNotifications } from "@/lib/console/notifications";

type Row = Parameters<typeof toNotifications>[0][number];

function group(over: Partial<Record<keyof Row, unknown>> = {}): Row {
  return {
    id: "g1",
    title: "Add a dark mode toggle",
    status: "pr_open",
    report_count: 3,
    user_report_count: 1,
    issue_url: "https://github.com/acme/app/issues/12",
    issue_number: 12,
    pr_url: null,
    first_seen: "2026-08-20T10:00:00Z",
    last_seen: "2026-08-20T10:05:00Z",
    ...over,
  } as Row;
}

describe("toNotifications", () => {
  it("turns one request into the issue and the pull request it opened", () => {
    const found = toNotifications([group({ pr_url: "https://github.com/acme/app/pull/13" })]);
    expect(found.map((item) => item.kind)).toEqual(["pull_request", "issue"]);
    expect(found[0]?.number).toBe(13);
    expect(found[0]?.title).toBe("Add a dark mode toggle");
    expect(found[0]?.id).toBe("g1:pull_request:13");
    expect(found[1]?.id).toBe("g1:issue:12");
  });

  it("carries the weight behind the request", () => {
    const [item] = toNotifications([group()]);
    expect(item?.reportCount).toBe(3);
    expect(item?.userReportCount).toBe(1);
  });

  it("skips a request that has opened nothing yet", () => {
    expect(toNotifications([group({ issue_url: null, issue_number: null })])).toEqual([]);
  });

  it("puts the newest first", () => {
    const found = toNotifications([
      group({ id: "old", last_seen: "2026-08-01T00:00:00Z" }),
      group({ id: "new", last_seen: "2026-08-22T00:00:00Z" }),
    ]);
    expect(found.map((item) => item.groupId)).toEqual(["new", "old"]);
  });

  it("falls back to when the request was first seen", () => {
    const found = toNotifications([group({ last_seen: null })]);
    expect(found[0]?.at).toBe("2026-08-20T10:00:00Z");
  });

  it("names a request that has no title", () => {
    expect(toNotifications([group({ title: null })])[0]?.title).toBe("Feature request");
    expect(toNotifications([group({ title: "  " })])[0]?.title).toBe("Feature request");
  });

  it("dates each line by when it was opened, not by the last report", () => {
    const found = toNotifications([
      group({
        pr_url: "https://github.com/acme/app/pull/13",
        issue_opened_at: "2026-08-20T10:06:00Z",
        pr_opened_at: "2026-08-20T11:30:00Z",
      }),
    ]);
    expect(found.map((item) => [item.kind, item.at])).toEqual([
      ["pull_request", "2026-08-20T11:30:00Z"],
      ["issue", "2026-08-20T10:06:00Z"],
    ]);
  });

  it("puts a pull request opened just now above a newer report's issue", () => {
    const found = toNotifications([
      group({
        id: "reported-later",
        last_seen: "2026-08-22T09:00:00Z",
        issue_opened_at: "2026-08-22T09:00:05Z",
      }),
      group({
        id: "built-now",
        last_seen: "2026-08-20T10:05:00Z",
        issue_opened_at: "2026-08-20T10:05:10Z",
        pr_url: "https://github.com/acme/app/pull/14",
        pr_opened_at: "2026-08-22T09:20:00Z",
      }),
    ]);
    expect(found.map((item) => item.id)).toEqual([
      "built-now:pull_request:14",
      "reported-later:issue:12",
      "built-now:issue:12",
    ]);
  });

  it("compares instants, not strings, across time zone notations", () => {
    const found = toNotifications([
      group({ id: "a", issue_opened_at: "2026-08-20T12:00:00+02:00" }),
      group({ id: "b", issue_opened_at: "2026-08-20T10:30:00Z" }),
    ]);
    expect(found.map((item) => item.groupId)).toEqual(["b", "a"]);
  });

  it("gives a second pull request for the same request its own id", () => {
    const first = toNotifications([group({ pr_url: "https://github.com/acme/app/pull/13" })]);
    const second = toNotifications([group({ pr_url: "https://github.com/acme/app/pull/21" })]);
    expect(first[0]?.id).not.toBe(second[0]?.id);
  });

  it("never hands the bell more than ten things to show", () => {
    const rows = Array.from({ length: 9 }, (_, index) =>
      group({
        id: `g${index}`,
        last_seen: `2026-08-${String(index + 1).padStart(2, "0")}T00:00:00Z`,
        pr_url: `https://github.com/acme/app/pull/${index}`,
      }),
    );
    expect(toNotifications(rows)).toHaveLength(10);
  });
});
