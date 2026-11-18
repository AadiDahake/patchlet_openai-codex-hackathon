/**
 * The live trace tail.
 *
 * Polls every 700 ms through `pollingEventStream` and writes anything new as a server-sent event.
 * Each event carries the row id, so a reconnecting `EventSource` resumes exactly where it stopped
 * through `Last-Event-ID`.
 */
import { withCors, preflight } from "@/lib/cors";
import { asErrorResponse, currentProject } from "@/lib/console/current";
import { fetchTrace, readFilters } from "@/lib/console/traceQuery";
import { pollingEventStream } from "@/lib/sse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

const POLL_MS = 700;
const PING_MS = 15_000;
const LIFETIME_MS = 240_000;

export function OPTIONS(): Response {
  return preflight();
}

export async function GET(request: Request): Promise<Response> {
  const project = await currentProject().catch(asErrorResponse);
  if (project instanceof Response) return project;

  const url = new URL(request.url);
  const filters = readFilters(url, project.id);
  const resumeFrom = Number(request.headers.get("last-event-id") ?? "0");
  let cursor = Number.isFinite(resumeFrom) && resumeFrom > filters.since ? resumeFrom : filters.since;

  return withCors(
    pollingEventStream(request, {
      pollMs: POLL_MS,
      pingMs: PING_MS,
      lifetimeMs: LIFETIME_MS,
      poll: async (sink) => {
        const events = await fetchTrace({ ...filters, since: cursor });
        for (const event of events) {
          cursor = Math.max(cursor, event.id);
          sink.event("trace", event, event.id);
        }
      },
    }),
  );
}
