// Test helpers: an Anthropic client whose `fetch` replays a recorded SSE stream.
import Anthropic from "@anthropic-ai/sdk";

/** The live smoke test runs only when explicitly requested and never under CI. */
export function liveEnabled(env: Record<string, string | undefined>): boolean {
  return env.LIVE_TESTS === "1" && !env.CI;
}

export interface RecordedCall {
  url: string;
  headers: Headers;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
}

export interface MockAnthropic {
  client: Anthropic;
  calls: RecordedCall[];
}

type Responder = (call: RecordedCall) => Response | Promise<Response>;

export function mockAnthropic(respond: Responder): MockAnthropic {
  const calls: RecordedCall[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call: RecordedCall = {
      url: typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
      headers: new Headers(init?.headers),
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
      signal: init?.signal,
    };
    calls.push(call);
    return respond(call);
  };
  return { client: new Anthropic({ apiKey: "test-key", fetch, maxRetries: 0 }), calls };
}

/** Serialises Anthropic stream events as the API's SSE wire format. */
export function anthropicSse(events: Array<{ type: string } & Record<string, unknown>>): string {
  return events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join("");
}

export function sseOk(body: string | ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

export function messageStart(
  model = "claude-opus-5-5",
): { type: string } & Record<string, unknown> {
  return {
    type: "message_start",
    message: {
      id: "msg_test",
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      stop_details: null,
      usage: {
        input_tokens: 12,
        output_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
  };
}

export function textEvents(
  deltas: string[],
  index = 0,
): Array<{ type: string } & Record<string, unknown>> {
  return [
    { type: "content_block_start", index, content_block: { type: "text", text: "" } },
    ...deltas.map((text) => ({
      type: "content_block_delta",
      index,
      delta: { type: "text_delta", text },
    })),
    { type: "content_block_stop", index },
  ];
}

export function messageEnd(
  stopReason: string,
  stopDetails: Record<string, unknown> | null = null,
  outputTokens = 7,
): Array<{ type: string } & Record<string, unknown>> {
  return [
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null, stop_details: stopDetails },
      usage: { output_tokens: outputTokens },
    },
    { type: "message_stop" },
  ];
}
