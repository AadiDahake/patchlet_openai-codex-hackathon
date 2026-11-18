/**
 * A server-sent event stream fed by polling.
 *
 * Postgres has no push channel the service role client can hold open cheaply here, so a live
 * console view polls on the server and writes what changed as server-sent events. The trace tail
 * and the notification feed share this loop, so both close, ping and recover the same way.
 */

export type EventSink = {
  /** One frame. An `id` lets a reconnecting EventSource resume through `Last-Event-ID`. */
  event: (name: string, data: unknown, id?: number) => void;
};

export type PollingStreamOptions = {
  pollMs: number;
  /** Closing well inside the platform's limit lets EventSource reconnect on its own terms. */
  lifetimeMs: number;
  /** A comment line this often keeps proxies from closing an idle connection. */
  pingMs: number;
  /** Runs once per poll, the first time at once. A throw is sent as an `error` event. */
  poll: (sink: EventSink) => Promise<void>;
};

const SSE_HEADERS = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/** One SSE frame as text. Exported for the tests; JSON keeps a payload on a single `data` line. */
export function sseFrame(name: string, data: unknown, id?: number): string {
  const head = id === undefined ? "" : `id: ${id}\n`;
  return `${head}event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;
}

export function pollingEventStream(request: Request, options: PollingStreamOptions): Response {
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const startedAt = Date.now();
      let lastPing = startedAt;
      let closed = false;

      const write = (text: string) => {
        if (closed) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          closed = true;
        }
      };

      const finish = () => {
        if (closed) return;
        closed = true;
        try {
          controller.close();
        } catch {
          // The client already went away.
        }
      };

      const sink: EventSink = { event: (name, data, id) => write(sseFrame(name, data, id)) };

      request.signal.addEventListener("abort", finish);
      write(": open\n\n");

      while (!closed && Date.now() - startedAt < options.lifetimeMs) {
        try {
          await options.poll(sink);
        } catch (error) {
          sink.event("error", { message: (error as Error).message });
        }

        if (Date.now() - lastPing > options.pingMs) {
          lastPing = Date.now();
          write(": ping\n\n");
        }

        await new Promise((resolve) => setTimeout(resolve, options.pollMs));
      }

      finish();
    },
  });

  return new Response(stream, { headers: SSE_HEADERS });
}
