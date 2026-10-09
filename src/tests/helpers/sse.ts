/**
 * Integration helpers for the admin SSE channel.
 *
 * A hijacked `text/event-stream` response never ends, so `app.inject()` cannot
 * be used on it — it waits for `end`. These helpers talk to a really listening
 * socket instead.
 */

export interface SseStream {
  status: number;
  contentType: string | null;
  cacheControl: string | null;
  /** Accumulate raw frames until `predicate` matches; reject on timeout. */
  readUntil(predicate: (text: string) => boolean, timeoutMs?: number): Promise<string>;
  close(): void;
}

const TIMEOUT = Symbol("timeout");

/** Open `/api/admin/events` on a listening test server. */
export async function openEventStream(
  baseUrl: string,
  cookie?: string,
): Promise<SseStream> {
  const controller = new AbortController();
  const res = await fetch(`${baseUrl}/api/admin/events`, {
    headers: {
      accept: "text/event-stream",
      ...(cookie ? { cookie } : {}),
    },
    signal: controller.signal,
  });

  const reader = res.body?.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    status: res.status,
    contentType: res.headers.get("content-type"),
    cacheControl: res.headers.get("cache-control"),
    async readUntil(predicate, timeoutMs = 5_000) {
      if (!reader) throw new Error("response has no body");
      const deadline = Date.now() + timeoutMs;
      while (!predicate(buffer)) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new Error(`timed out waiting; received ${JSON.stringify(buffer)}`);
        }
        const chunk = await Promise.race([
          reader.read(),
          new Promise<typeof TIMEOUT>((resolve) =>
            setTimeout(() => resolve(TIMEOUT), remaining),
          ),
        ]);
        if (chunk === TIMEOUT) {
          throw new Error(`timed out waiting; received ${JSON.stringify(buffer)}`);
        }
        if (chunk.done) {
          throw new Error(`stream ended early; received ${JSON.stringify(buffer)}`);
        }
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      return buffer;
    },
    close() {
      controller.abort();
    },
  };
}

/** Extract every complete `event: <name>` frame from an accumulated buffer. */
export function frames(text: string): string[] {
  return text
    .split("\n\n")
    .filter((block) => block.includes("event: "))
    .map((block) => `${block}\n\n`);
}
