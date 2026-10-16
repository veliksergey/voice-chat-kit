import { type ChatEvent, parseChatEvent, parseSse } from "@voice-chat-kit/core";
import { describe, expect, it } from "vitest";
import { createVoiceChatHandlers } from "./handlers.js";
import {
  anthropicSse,
  messageEnd,
  messageStart,
  mockAnthropic,
  sseOk,
  textEvents,
} from "./test-support.js";

const SYSTEM = "You are a concise voice assistant.";

function chatRequest(messages: unknown, init: RequestInit = {}): Request {
  return new Request("http://localhost/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ messages }),
    ...init,
  });
}

async function collect(response: Response): Promise<ChatEvent[]> {
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/event-stream");
  if (!response.body) throw new Error("no body");
  const events: ChatEvent[] = [];
  for await (const frame of parseSse(response.body)) events.push(parseChatEvent(frame));
  return events;
}

describe("chat handler", () => {
  it("streams text deltas then done, and sends the configured Claude parameters", async () => {
    const mock = mockAnthropic(() =>
      sseOk(
        anthropicSse([
          messageStart(),
          ...textEvents(["Hello", " world"]),
          ...messageEnd("end_turn"),
        ]),
      ),
    );
    const handlers = createVoiceChatHandlers({
      anthropic: { client: mock.client, effort: "low", maxTokens: 4096 },
      system: SYSTEM,
    });

    const events = await collect(
      await handlers.chat(chatRequest([{ role: "user", content: "hi" }])),
    );

    expect(events).toEqual([
      { type: "text", delta: "Hello" },
      { type: "text", delta: " world" },
      {
        type: "done",
        stopReason: "end_turn",
        model: "claude-opus-5-5",
        usage: {
          inputTokens: 12,
          outputTokens: 7,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
        },
      },
    ]);

    const call = mock.calls[0];
    expect(call?.url).toContain("/v1/messages");
    expect(call?.headers.get("anthropic-beta")).toContain("server-side-fallback-2026-07-01");
    expect(call?.body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 4096,
      stream: true,
      fallbacks: "default",
      cache_control: { type: "ephemeral" },
      output_config: { effort: "low" },
      system: SYSTEM,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(call?.body).not.toHaveProperty("thinking");
  });

  it("emits refusal after partial text when the stream ends in a terminal refusal", async () => {
    const mock = mockAnthropic(() =>
      sseOk(
        anthropicSse([
          messageStart(),
          ...textEvents(["Partial"]),
          ...messageEnd("refusal", { type: "refusal", category: "cyber", explanation: "declined" }),
        ]),
      ),
    );
    const handlers = createVoiceChatHandlers({
      anthropic: { client: mock.client },
      system: SYSTEM,
    });

    const events = await collect(
      await handlers.chat(chatRequest([{ role: "user", content: "hi" }])),
    );

    expect(events).toEqual([
      { type: "text", delta: "Partial" },
      { type: "refusal", category: "cyber", explanation: "declined" },
    ]);
  });

  it("reports a fallback block as a fallback event", async () => {
    const mock = mockAnthropic(() =>
      sseOk(
        anthropicSse([
          messageStart("claude-opus-4-8"),
          {
            type: "content_block_start",
            index: 0,
            content_block: {
              type: "fallback",
              from: { model: "claude-opus-5-5" },
              to: { model: "claude-opus-4-8" },
              reason: { type: "refusal", category: "cyber", explanation: null },
            },
          },
          { type: "content_block_stop", index: 0 },
          ...textEvents(["ok"], 1),
          ...messageEnd("end_turn"),
        ]),
      ),
    );
    const handlers = createVoiceChatHandlers({
      anthropic: { client: mock.client },
      system: SYSTEM,
    });

    const events = await collect(
      await handlers.chat(chatRequest([{ role: "user", content: "hi" }])),
    );

    expect(events[0]).toEqual({ type: "fallback", from: "claude-opus-5-5", to: "claude-opus-4-8" });
    expect(events[1]).toEqual({ type: "text", delta: "ok" });
    expect(events.at(-1)).toMatchObject({ type: "done", model: "claude-opus-4-8" });
  });

  it("turns an API error into an error event without leaking the upstream message", async () => {
    const mock = mockAnthropic(
      () =>
        new Response(
          JSON.stringify({
            type: "error",
            error: { type: "rate_limit_error", message: "secret upstream detail" },
          }),
          { status: 429, headers: { "content-type": "application/json" } },
        ),
    );
    const handlers = createVoiceChatHandlers({
      anthropic: { client: mock.client },
      system: SYSTEM,
    });

    const events = await collect(
      await handlers.chat(chatRequest([{ role: "user", content: "hi" }])),
    );

    expect(events).toEqual([{ type: "error", message: "Claude API error (429)", status: 429 }]);
    expect(JSON.stringify(events)).not.toContain("secret upstream detail");
  });

  it("aborts the upstream request when the client aborts", async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    const mock = mockAnthropic((call) => {
      upstreamSignal = call.signal;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(anthropicSse([messageStart(), ...textEvents(["Hel"]).slice(0, 2)])),
          );
          // Never closes on its own. Like real fetch, the body errors when the request is aborted.
          call.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("The operation was aborted.", "AbortError")),
          );
        },
      });
      return sseOk(body);
    });
    const handlers = createVoiceChatHandlers({
      anthropic: { client: mock.client },
      system: SYSTEM,
    });

    const controller = new AbortController();
    const response = await handlers.chat(
      chatRequest([{ role: "user", content: "hi" }], { signal: controller.signal }),
    );
    if (!response.body) throw new Error("no body");
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"delta":"Hel"');

    controller.abort();
    const rest = await reader.read();
    expect(rest.done).toBe(true);
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("rejects invalid bodies with 400 and non-POST with 405 before calling Claude", async () => {
    const mock = mockAnthropic(() => {
      throw new Error("must not be called");
    });
    const handlers = createVoiceChatHandlers({
      anthropic: { client: mock.client },
      system: SYSTEM,
    });

    const bad = await handlers.chat(
      chatRequest([
        { role: "system", content: "x" },
        { role: "user", content: "q" },
      ]),
    );
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: expect.stringContaining("role") });

    const get = await handlers.chat(new Request("http://localhost/api/chat", { method: "GET" }));
    expect(get.status).toBe(405);

    const big = await handlers.chat(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json", "content-length": String(70 * 1024) },
        body: "{}",
      }),
    );
    expect(big.status).toBe(400);
    expect(mock.calls).toHaveLength(0);
  });

  it("rejects a non-JSON content type with 415 before reading the body", async () => {
    const mock = mockAnthropic(() => {
      throw new Error("must not be called");
    });
    const handlers = createVoiceChatHandlers({
      anthropic: { client: mock.client },
      system: SYSTEM,
    });
    // A cross-site "simple" POST can carry valid JSON under text/plain without a preflight.
    const response = await handlers.chat(
      new Request("http://localhost/api/chat", {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
      }),
    );
    expect(response.status).toBe(415);
    expect(mock.calls).toHaveLength(0);
  });

  it("aborts the upstream request when the response body is cancelled without a request abort", async () => {
    let upstreamSignal: AbortSignal | null | undefined;
    const mock = mockAnthropic((call) => {
      upstreamSignal = call.signal;
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(anthropicSse([messageStart(), ...textEvents(["Hel"]).slice(0, 2)])),
          );
          // Stalled between deltas; errors on abort like real fetch.
          call.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("The operation was aborted.", "AbortError")),
          );
        },
      });
      return sseOk(body);
    });
    const handlers = createVoiceChatHandlers({
      anthropic: { client: mock.client },
      system: SYSTEM,
    });

    // No AbortController on the request: only the consumer walks away from the body.
    const response = await handlers.chat(chatRequest([{ role: "user", content: "hi" }]));
    if (!response.body) throw new Error("no body");
    const reader = response.body.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('"delta":"Hel"');
    expect(upstreamSignal?.aborted).toBe(false);

    await reader.cancel(); // resolves only if the stalled upstream read is interrupted
    expect(upstreamSignal?.aborted).toBe(true);
  });

  it("stops reading a chunked body without Content-Length once it exceeds the byte limit", async () => {
    const mock = mockAnthropic(() => {
      throw new Error("must not be called");
    });
    const handlers = createVoiceChatHandlers({
      anthropic: { client: mock.client },
      system: SYSTEM,
    });
    let pulls = 0;
    let cancelled = false;
    const chunk = new Uint8Array(8 * 1024).fill(0x61);
    // An endless upload: without incremental reading the handler would never answer.
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(chunk);
      },
      cancel() {
        cancelled = true;
      },
    });
    const request = new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    } as RequestInit);

    const response = await handlers.chat(request);

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: expect.stringContaining("Body exceeds") });
    expect(cancelled).toBe(true);
    expect(pulls).toBeLessThan(20); // 64 KB limit reached after ~9 chunks
    expect(mock.calls).toHaveLength(0);
  });
});

describe("token and providers handlers", () => {
  const handlers = createVoiceChatHandlers({
    anthropic: { client: mockAnthropic(() => sseOk("")).client },
    system: SYSTEM,
    tokenIssuers: [
      { id: "fake", issue: async () => ({ token: "t0k", expiresAt: 1_700_000_000_000 }) },
    ],
  });

  it("lists registered issuers", async () => {
    const response = handlers.providers(new Request("http://localhost/api/providers"));
    expect(await response.json()).toEqual({ tokenIssuers: ["fake"] });
  });

  it("issues a token for a registered provider and 404s otherwise", async () => {
    const ok = await handlers.token(
      new Request("http://localhost/api/token/fake", { method: "POST" }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ token: "t0k", expiresAt: 1_700_000_000_000 });

    const explicit = await handlers.token(
      new Request("http://localhost/x", { method: "POST" }),
      "fake",
    );
    expect(explicit.status).toBe(200);

    const missing = await handlers.token(
      new Request("http://localhost/api/token/nope", { method: "POST" }),
    );
    expect(missing.status).toBe(404);

    const get = await handlers.token(
      new Request("http://localhost/api/token/fake", { method: "GET" }),
    );
    expect(get.status).toBe(405);
  });

  it("answers health", async () => {
    const response = handlers.health(new Request("http://localhost/healthz"));
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("ok");
  });
});
