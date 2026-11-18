/**
 * The bell's live feed: the same list as `GET /api/notifications`, sent at once and then again
 * whenever it changes.
 *
 * It rides the trace tail's mechanism (`pollingEventStream`): the console bar is on every console
 * page, and a pull request should reach it within a couple of seconds of the worker opening it,
 * not at the next minute's poll. The list is small and only sent when it differs, so an idle
 * console costs one indexed read every two seconds and no traffic.
 */
import { withCors, preflight } from "@/lib/cors";
import { loadNotifications } from "@/lib/console/notifications";
import { asErrorResponse, currentProject } from "@/lib/console/current";
import { pollingEventStream } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const POLL_MS = 2_000;
const PING_MS = 15_000;
const LIFETIME_MS = 240_000;

export function OPTIONS(): Response {
  return preflight();
}

export async function GET(request: Request): Promise<Response> {
  const project = await currentProject().catch(asErrorResponse);
  if (project instanceof Response) return project;

  let last = "";
  return withCors(
    pollingEventStream(request, {
      pollMs: POLL_MS,
      pingMs: PING_MS,
      lifetimeMs: LIFETIME_MS,
      poll: async (sink) => {
        const notifications = await loadNotifications(project.id);
        const frame = JSON.stringify(notifications);
        if (frame === last) return;
        last = frame;
        sink.event("notifications", { notifications });
      },
    }),
  );
}
