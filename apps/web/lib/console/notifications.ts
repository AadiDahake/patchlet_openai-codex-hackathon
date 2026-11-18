/**
 * What the worker has opened on GitHub, for the bell in the console bar.
 *
 * The unit is the request, not the conversation. Ten people asking for the same thing is one
 * issue and one pull request, so it is one line in the bell with the weight behind it, rather
 * than ten identical lines that bury everything else.
 *
 * Each line is dated by when that thing was opened (`issue_opened_at`, `pr_opened_at`, stamped by
 * the database in migration 0019), never by when the gap was last reported: a pull request opened
 * a minute ago is the newest thing in the bell even when its request was first reported last week.
 */
import { serviceClient } from "@/lib/supabase";

export type NotificationKind = "issue" | "pull_request";

export type Notification = {
  /**
   * Stable across reloads, so "read" can be remembered without a server round trip. It names the
   * GitHub number, so a second pull request for the same request is a new line, not an old one.
   */
  id: string;
  groupId: string;
  kind: NotificationKind;
  number: number | null;
  url: string;
  title: string;
  status: string;
  /** How many conversations are behind this, and how many of them asked outright. */
  reportCount: number;
  userReportCount: number;
  /** When this issue or pull request was opened. */
  at: string;
};

export const NOTIFICATION_LIMIT = 10;

const GROUP_COLUMNS =
  "id, title, status, report_count, user_report_count, issue_url, issue_number, pr_url, issue_opened_at, pr_opened_at, first_seen, last_seen";

type GroupRow = {
  id: unknown;
  title: unknown;
  status: unknown;
  report_count: unknown;
  user_report_count: unknown;
  issue_url: unknown;
  issue_number: unknown;
  pr_url: unknown;
  issue_opened_at?: unknown;
  pr_opened_at?: unknown;
  first_seen: unknown;
  last_seen: unknown;
};

function groupTitle(title: unknown): string {
  return typeof title === "string" && title.trim() !== "" ? title.trim() : "Feature request";
}

/** The number GitHub gave the pull request, read back off its own URL. */
function pullNumber(url: string): number | null {
  const match = /\/pull\/(\d+)/.exec(url);
  return match ? Number(match[1]) : null;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** The first of these that is a real timestamp. */
function firstTime(...values: unknown[]): string {
  for (const value of values) {
    const candidate = text(value);
    if (candidate !== "") return candidate;
  }
  return "";
}

/** Milliseconds since the epoch, so offsets like `+00:00` and `Z` compare as the same instant. */
function instant(at: string): number {
  const value = Date.parse(at);
  return Number.isNaN(value) ? 0 : value;
}

/** The pull request is always the later of the two, so it reads first inside one request. */
const KIND_ORDER: Record<NotificationKind, number> = { pull_request: 0, issue: 1 };

/** Flattens request groups into the newest things the worker opened for them. */
export function toNotifications(rows: GroupRow[]): Notification[] {
  const found: Notification[] = [];

  for (const row of rows) {
    const groupId = String(row.id);
    // Rows from before migration 0019 have no opened-at stamp; the report dates are all they have.
    const reported = firstTime(row.last_seen, row.first_seen);
    const common = {
      groupId,
      title: groupTitle(row.title),
      status: String(row.status ?? ""),
      reportCount: Number(row.report_count ?? 0),
      userReportCount: Number(row.user_report_count ?? 0),
    };

    const issueUrl = text(row.issue_url);
    if (issueUrl !== "") {
      const number =
        row.issue_number === null || row.issue_number === undefined ? null : Number(row.issue_number);
      found.push({
        ...common,
        id: `${groupId}:issue:${number ?? issueUrl}`,
        kind: "issue",
        number,
        url: issueUrl,
        at: firstTime(row.issue_opened_at, reported),
      });
    }

    const prUrl = text(row.pr_url);
    if (prUrl !== "") {
      const number = pullNumber(prUrl);
      found.push({
        ...common,
        id: `${groupId}:pull_request:${number ?? prUrl}`,
        kind: "pull_request",
        number,
        url: prUrl,
        at: firstTime(row.pr_opened_at, reported),
      });
    }
  }

  return found
    .sort((a, b) => instant(b.at) - instant(a.at) || KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
    .slice(0, NOTIFICATION_LIMIT);
}

export async function loadNotifications(projectId: string): Promise<Notification[]> {
  // Ordered by the newest thing opened per group, so the ten groups read here hold the ten newest
  // lines: a line can only be newer than another group's if its own group sorts above it.
  const { data, error } = await serviceClient()
    .from("feature_request_group")
    .select(GROUP_COLUMNS)
    .eq("project_id", projectId)
    .or("issue_url.not.is.null,pr_url.not.is.null")
    .order("opened_at", { ascending: false, nullsFirst: false })
    .order("last_seen", { ascending: false })
    .limit(NOTIFICATION_LIMIT);
  if (error) throw new Error(error.message);

  return toNotifications((data ?? []) as GroupRow[]);
}
