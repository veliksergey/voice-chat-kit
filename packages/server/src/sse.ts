import type { ChatEvent } from "@voice-chat-kit/core";

/** Encodes one chat event as an SSE frame: `event: <type>` + JSON of the remaining fields. */
export function encodeChatEvent(event: ChatEvent): string {
  const { type, ...payload } = event;
  return `event: ${type}\ndata: ${JSON.stringify(payload)}\n\n`;
}

/**
 * Wraps an event iterator in a streaming `text/event-stream` response. When the consumer cancels
 * the body, `upstream` is aborted first: the generator may be awaiting an upstream read, and
 * `iterator.return()` alone would queue behind it instead of interrupting it.
 */
export function sseResponse(
  events: AsyncIterable<ChatEvent>,
  upstream?: AbortController,
): Response {
  const iterator = events[Symbol.asyncIterator]();
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await iterator.next();
      if (done) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(encodeChatEvent(value)));
    },
    async cancel() {
      upstream?.abort();
      await iterator.return?.();
    },
  });
  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
