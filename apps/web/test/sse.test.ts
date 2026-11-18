import { describe, expect, it } from "vitest";
import { pollingEventStream, sseFrame } from "@/lib/sse";

async function readUntil(response: Response, done: (text: string) => boolean): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let text = "";
  while (!done(text)) {
    const { value, done: ended } = await reader.read();
    if (ended) break;
    text += decoder.decode(value);
  }
  await reader.cancel();
  return text;
}

describe("sseFrame", () => {
  it("writes one event on one data line, with the id when there is one", () => {
    expect(sseFrame("trace", { a: "x\ny" }, 7)).toBe('id: 7\nevent: trace\ndata: {"a":"x\\ny"}\n\n');
    expect(sseFrame("notifications", [])).toBe("event: notifications\ndata: []\n\n");
  });
});

describe("pollingEventStream", () => {
  it("polls at once, then again, and sends what each poll emits", async () => {
    let polls = 0;
    const controller = new AbortController();
    const response = pollingEventStream(new Request("http://x", { signal: controller.signal }), {
      pollMs: 5,
      pingMs: 60_000,
      lifetimeMs: 5_000,
      poll: async (sink) => {
        polls += 1;
        sink.event("tick", { polls });
      },
    });
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const text = await readUntil(response, (seen) => seen.includes('"polls":2'));
    controller.abort();
    expect(text.startsWith(": open\n\n")).toBe(true);
    expect(text).toContain('event: tick\ndata: {"polls":1}');
  });

  it("turns a failed poll into an error event and keeps going", async () => {
    let polls = 0;
    const controller = new AbortController();
    const response = pollingEventStream(new Request("http://x", { signal: controller.signal }), {
      pollMs: 5,
      pingMs: 60_000,
      lifetimeMs: 5_000,
      poll: async (sink) => {
        polls += 1;
        if (polls === 1) throw new Error("database away");
        sink.event("tick", { polls });
      },
    });
    const text = await readUntil(response, (seen) => seen.includes("event: tick"));
    controller.abort();
    expect(text).toContain('event: error\ndata: {"message":"database away"}');
    expect(text).toContain('"polls":2');
  });
});
