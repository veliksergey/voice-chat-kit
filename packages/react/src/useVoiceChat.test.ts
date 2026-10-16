// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useVoiceChat } from "./useVoiceChat.js";

type Frame = { event: string; data: Record<string, unknown> };

function sse(frames: Frame[]): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join("");
}

const DONE: Frame = {
  event: "done",
  data: {
    stopReason: "end_turn",
    model: "claude-opus-5-5",
    usage: {
      inputTokens: 1,
      outputTokens: 2,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
    },
  },
};

interface Call {
  url: string;
  body: { messages: Array<{ role: string; content: string }> };
  signal: AbortSignal | null | undefined;
}

function fetchStub(respond: (call: Call) => Response | Promise<Response>): {
  fetch: typeof globalThis.fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const call: Call = {
      url: String(input),
      body: JSON.parse(String(init?.body)) as Call["body"],
      signal: init?.signal,
    };
    calls.push(call);
    return respond(call);
  };
  return { fetch, calls };
}

function streamResponse(text: string): Response {
  return new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
}

function badRequest(message: string): Response {
  return new Response(JSON.stringify({ error: message }), {
    status: 400,
    headers: { "content-type": "application/json" },
  });
}

/**
 * A body that never closes on its own and, like real fetch, errors when the request is aborted.
 * `onCancel` lets a test hold the consumer's cancellation open.
 */
function openBody(call: Call, frames: string, onCancel?: () => Promise<void>): Response {
  const encoder = new TextEncoder();
  const source: UnderlyingDefaultSource<Uint8Array> = {
    start(controller) {
      if (frames) controller.enqueue(encoder.encode(frames));
      call.signal?.addEventListener("abort", () =>
        controller.error(new DOMException("The operation was aborted.", "AbortError")),
      );
    },
  };
  if (onCancel) source.cancel = onCancel;
  return new Response(new ReadableStream<Uint8Array>(source), {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

describe("useVoiceChat (text path)", () => {
  it("streams a reply into the transcript and replays completed turns", async () => {
    const stub = fetchStub(() =>
      streamResponse(
        sse([
          { event: "text", data: { delta: "Hel" } },
          { event: "text", data: { delta: "lo" } },
          DONE,
        ]),
      ),
    );
    const { result } = renderHook(() => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }));

    await act(() => result.current.sendText("hi"));

    expect(result.current.state).toBe("idle");
    expect(result.current.messages.map((m) => [m.role, m.text, m.status])).toEqual([
      ["user", "hi", "complete"],
      ["assistant", "Hello", "complete"],
    ]);
    expect(result.current.usage?.outputTokens).toBe(2);
    expect(stub.calls[0]?.url).toBe("/api/chat");
    expect(stub.calls[0]?.body.messages).toEqual([{ role: "user", content: "hi" }]);

    await act(() => result.current.sendText("again"));
    expect(stub.calls[1]?.body.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello" },
      { role: "user", content: "again" },
    ]);
  });

  it("drops a refused turn from replay history but keeps it in the transcript", async () => {
    let n = 0;
    const stub = fetchStub(() => {
      n += 1;
      return streamResponse(
        n === 1
          ? sse([
              { event: "text", data: { delta: "partial" } },
              { event: "refusal", data: { category: "cyber", explanation: "declined" } },
            ])
          : sse([{ event: "text", data: { delta: "fine" } }, DONE]),
      );
    });
    const { result } = renderHook(() => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }));

    await act(() => result.current.sendText("bad question"));
    expect(result.current.lastRefusal).toEqual({ category: "cyber", explanation: "declined" });
    expect(result.current.messages.map((m) => m.status)).toEqual(["refused", "refused"]);
    expect(result.current.messages[1]?.text).toBe("partial");
    expect(result.current.state).toBe("idle");

    await act(() => result.current.sendText("ok question"));
    expect(stub.calls[1]?.body.messages).toEqual([{ role: "user", content: "ok question" }]);
    expect(result.current.messages).toHaveLength(4);
  });

  it("surfaces server errors, enters the error state, and recovers on the next send", async () => {
    let n = 0;
    const stub = fetchStub(() => {
      n += 1;
      if (n === 1) {
        return streamResponse(
          sse([{ event: "error", data: { message: "Claude API error (429)", status: 429 } }]),
        );
      }
      // A single-turn window cannot be reduced, so a 400 here is not retried.
      if (n === 2) return badRequest("messages.0.role: nope");
      return streamResponse(sse([{ event: "text", data: { delta: "ok" } }, DONE]));
    });
    const { result } = renderHook(() => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }));

    await act(() => result.current.sendText("one"));
    expect(result.current.state).toBe("error");
    expect(result.current.error).toBe("Claude API error (429)");
    expect(result.current.messages.map((m) => m.status)).toEqual(["error", "error"]);

    await act(() => result.current.sendText("two"));
    expect(result.current.error).toBe("messages.0.role: nope");
    expect(stub.calls).toHaveLength(2);
    expect(stub.calls[1]?.body.messages).toEqual([{ role: "user", content: "two" }]);

    await act(() => result.current.sendText("three"));
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.messages.at(-1)?.text).toBe("ok");
  });

  it("retries once with the oldest half of the turns dropped when the server answers 400", async () => {
    let n = 0;
    const stub = fetchStub(() => {
      n += 1;
      if (n <= 4) return streamResponse(sse([{ event: "text", data: { delta: `a${n}` } }, DONE]));
      if (n === 5) return badRequest("Body exceeds 1 bytes");
      return streamResponse(sse([{ event: "text", data: { delta: "ok" } }, DONE]));
    });
    const { result } = renderHook(() => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }));

    for (const text of ["q1", "q2", "q3", "q4"]) {
      await act(() => result.current.sendText(text));
    }
    await act(() => result.current.sendText("q5"));

    // Full window first (4 turns + new user = 9), then the newest 3 turns (5 messages).
    expect(stub.calls[4]?.body.messages).toHaveLength(9);
    expect(stub.calls[5]?.body.messages).toEqual([
      { role: "user", content: "q3" },
      { role: "assistant", content: "a3" },
      { role: "user", content: "q4" },
      { role: "assistant", content: "a4" },
      { role: "user", content: "q5" },
    ]);
    expect(result.current.error).toBeNull();
    expect(result.current.state).toBe("idle");
    expect(result.current.messages.at(-1)).toMatchObject({ role: "assistant", text: "ok" });
  });

  it("fails after a second 400, and newConversation clears everything so chat can continue", async () => {
    let n = 0;
    const stub = fetchStub(() => {
      n += 1;
      if (n <= 2) return streamResponse(sse([{ event: "text", data: { delta: "a" } }, DONE]));
      if (n <= 4) return badRequest("Body exceeds 1 bytes");
      return streamResponse(sse([{ event: "text", data: { delta: "fresh" } }, DONE]));
    });
    const { result } = renderHook(() => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }));

    await act(() => result.current.sendText("q1"));
    await act(() => result.current.sendText("q2"));
    await act(() => result.current.sendText("q3"));

    expect(stub.calls).toHaveLength(4); // 2 successes + the rejected send + its single retry
    expect(result.current.state).toBe("error");
    expect(result.current.error).toBe("Body exceeds 1 bytes");

    act(() => result.current.newConversation());
    expect(result.current.messages).toEqual([]);
    expect(result.current.error).toBeNull();
    expect(result.current.state).toBe("idle");

    await act(() => result.current.sendText("q4"));
    expect(stub.calls[4]?.body.messages).toEqual([{ role: "user", content: "q4" }]);
    expect(result.current.messages.map((m) => m.text)).toEqual(["q4", "fresh"]);
  });

  it("stop() aborts the request and keeps the partial reply", async () => {
    let upstream: AbortSignal | null | undefined;
    const stub = fetchStub((call) => {
      upstream = call.signal;
      return openBody(call, sse([{ event: "text", data: { delta: "part" } }]));
    });
    const { result } = renderHook(() => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }));

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.sendText("go");
    });
    await waitFor(() => expect(result.current.messages[1]?.text).toBe("part"));
    expect(result.current.state).toBe("thinking");

    act(() => result.current.stop());
    await act(async () => {
      await pending;
    });

    expect(upstream?.aborted).toBe(true);
    expect(result.current.state).toBe("idle");
    expect(result.current.messages[1]).toMatchObject({ text: "part", status: "complete" });
  });

  it("ignores empty input", async () => {
    const stub = fetchStub(() => streamResponse(sse([DONE])));
    const { result } = renderHook(() => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }));
    await act(() => result.current.sendText("   "));
    expect(stub.calls).toHaveLength(0);
  });

  it("drops an empty reply when stopped before the first delta, so the next send still works", async () => {
    let n = 0;
    const stub = fetchStub((call) => {
      n += 1;
      if (n === 1) return openBody(call, "");
      return streamResponse(sse([{ event: "text", data: { delta: "ok" } }, DONE]));
    });
    const { result } = renderHook(() => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }));

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.sendText("first");
    });
    await waitFor(() => expect(result.current.state).toBe("thinking"));
    act(() => result.current.stop());
    await act(async () => {
      await pending;
    });

    // The empty placeholder is gone; only the user turn remains.
    expect(result.current.messages.map((m) => [m.role, m.status])).toEqual([["user", "complete"]]);
    expect(result.current.state).toBe("idle");

    await act(() => result.current.sendText("second"));
    expect(stub.calls[1]?.body.messages).toEqual([
      { role: "user", content: "first" },
      { role: "user", content: "second" },
    ]);
    expect(result.current.error).toBeNull();
    expect(result.current.messages.at(-1)).toMatchObject({ role: "assistant", text: "ok" });
  });

  it("ends the turn on a terminal event without waiting for EOF, and a stale request cannot touch the next turn", async () => {
    let n = 0;
    let releaseFirstCancel: (() => void) | undefined;
    const stub = fetchStub((call) => {
      n += 1;
      if (n === 1) {
        // Terminal error event, then the body's cancellation stays pending until released, so the
        // first turn's cleanup is still running when the second turn starts.
        return openBody(
          call,
          sse([{ event: "error", data: { message: "Claude API error (500)", status: 500 } }]),
          () =>
            new Promise<void>((resolve) => {
              releaseFirstCancel = resolve;
            }),
        );
      }
      return openBody(call, sse([{ event: "text", data: { delta: "part" } }]));
    });
    const { result } = renderHook(() => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }));

    let first: Promise<void> | undefined;
    act(() => {
      first = result.current.sendText("one");
    });
    // The error is visible while the first request's cleanup is still pending.
    await waitFor(() => expect(result.current.state).toBe("error"));
    await waitFor(() => expect(releaseFirstCancel).toBeDefined());

    let second: Promise<void> | undefined;
    act(() => {
      second = result.current.sendText("two");
    });
    await waitFor(() => expect(result.current.messages.at(-1)?.text).toBe("part"));
    expect(result.current.state).toBe("thinking");

    // Release the first turn; its tail must not flip the second turn to idle or set an error.
    await act(async () => {
      releaseFirstCancel?.();
      await first;
    });
    expect(result.current.state).toBe("thinking");
    expect(result.current.error).toBeNull();

    act(() => result.current.stop());
    await act(async () => {
      await second;
    });
    expect(result.current.state).toBe("idle");
  });

  it("aborts the in-flight request on unmount", async () => {
    let upstream: AbortSignal | null | undefined;
    const stub = fetchStub((call) => {
      upstream = call.signal;
      return openBody(call, sse([{ event: "text", data: { delta: "part" } }]));
    });
    const { result, unmount } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }),
    );

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.sendText("go");
    });
    await waitFor(() => expect(result.current.messages[1]?.text).toBe("part"));
    expect(upstream?.aborted).toBe(false);

    unmount();
    await pending;
    expect(upstream?.aborted).toBe(true);
  });

  it("fails a turn whose stream ends without a terminal event and keeps it out of replay", async () => {
    let n = 0;
    const stub = fetchStub(() => {
      n += 1;
      // First reply: one delta, then EOF with no done/refusal/error (upstream dropped).
      if (n === 1) return streamResponse(sse([{ event: "text", data: { delta: "half" } }]));
      return streamResponse(sse([{ event: "text", data: { delta: "ok" } }, DONE]));
    });
    const { result } = renderHook(() => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }));

    await act(() => result.current.sendText("one"));
    expect(result.current.state).toBe("error");
    expect(result.current.error).toMatch(/closed before the reply finished/);
    expect(result.current.messages.map((m) => [m.text, m.status])).toEqual([
      ["one", "error"],
      ["half", "error"],
    ]);

    await act(() => result.current.sendText("two"));
    expect(stub.calls[1]?.body.messages).toEqual([{ role: "user", content: "two" }]);
    expect(result.current.state).toBe("idle");
  });

  it("treats Stop during an HTTP error body as a cancellation, not a failure", async () => {
    const stub = fetchStub((call) => {
      // Error status whose body stalls; like real fetch it errors on abort.
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          call.signal?.addEventListener("abort", () =>
            controller.error(new DOMException("The operation was aborted.", "AbortError")),
          );
        },
      });
      return new Response(body, { status: 500, headers: { "content-type": "application/json" } });
    });
    const { result } = renderHook(() => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }));

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.sendText("go");
    });
    await waitFor(() => expect(stub.calls).toHaveLength(1));
    await act(async () => {
      await Promise.resolve(); // let the hook start reading the error body
    });

    act(() => result.current.stop());
    await act(async () => {
      await pending;
    });

    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(result.current.messages.map((m) => [m.role, m.status])).toEqual([["user", "complete"]]);
  });
});
