// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type { SttProvider, SttSession, SttStartOptions } from "@voice-chat-kit/core";
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
  method: string | undefined;
  body: unknown;
}

function fetchStub(): { fetch: typeof globalThis.fetch; calls: Call[] } {
  const calls: Call[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push({
      url,
      method: init?.method,
      body: init?.body ? JSON.parse(String(init.body)) : null,
    });
    if (url.endsWith("/token/needs-token")) {
      return new Response(JSON.stringify({ token: "jwt.1", expiresAt: 1_900_000_000_000 }), {
        status: 200,
      });
    }
    return new Response(sse([{ event: "text", data: { delta: "reply" } }, DONE]), {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
  };
  return { fetch, calls };
}

function sentMessages(call: Call | undefined): unknown {
  return (call?.body as { messages?: unknown } | null)?.messages;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface FakeSttConfig {
  id?: string;
  needsToken?: boolean;
  failStart?: boolean;
  stopText?: string;
  /** When given, start() waits for it before returning the session. */
  startGate?: Promise<void>;
  /** When given, stop() returns this promise instead of `stopText`. */
  stopResult?: Promise<string>;
}

/** Scripted STT provider: the test drives partial/final/error callbacks and the stop() result. */
function fakeStt(config: FakeSttConfig = {}) {
  const captured: {
    options?: SttStartOptions;
    stopCalls: number;
    aborted: boolean;
  } = { stopCalls: 0, aborted: false };
  const provider: SttProvider = {
    id: config.id ?? "fake",
    capabilities: {
      streaming: true,
      interimResults: true,
      runsInBrowser: true,
      needsToken: config.needsToken ?? false,
    },
    async start(options: SttStartOptions): Promise<SttSession> {
      if (config.failStart) throw new Error("microphone denied");
      if (options.getToken) await options.getToken();
      captured.options = options;
      options.signal.addEventListener("abort", () => {
        captured.aborted = true;
      });
      if (config.startGate) await config.startGate;
      return {
        async stop() {
          captured.stopCalls += 1;
          return config.stopResult ?? config.stopText ?? "spoken words";
        },
      };
    },
  };
  return { provider, captured };
}

describe("useVoiceChat listening (push-to-talk)", () => {
  it("listens, shows interim text, then sends the final transcript as the user turn", async () => {
    const stub = fetchStub();
    const { provider, captured } = fakeStt({ stopText: "hello claude" });
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, stt: provider, language: "en-US" }),
    );
    expect(result.current.sttProviderId).toBe("fake");

    await act(() => result.current.startListening());
    expect(result.current.state).toBe("listening");
    expect(captured.options?.language).toBe("en-US");
    expect(captured.options?.getToken).toBeUndefined();

    act(() => captured.options?.onPartial("hel"));
    expect(result.current.interimTranscript).toBe("hel");
    act(() => captured.options?.onFinal("hello claude"));
    expect(result.current.interimTranscript).toBe("");

    await act(() => result.current.stopListening());
    expect(captured.stopCalls).toBe(1);
    expect(stub.calls.map((c) => c.url)).toEqual(["/api/chat"]);
    expect(sentMessages(stub.calls[0])).toEqual([{ role: "user", content: "hello claude" }]);
    expect(result.current.state).toBe("idle");
    expect(result.current.messages.map((m) => [m.role, m.text])).toEqual([
      ["user", "hello claude"],
      ["assistant", "reply"],
    ]);
  });

  it("fetches a short-lived token from the server for providers that need one", async () => {
    const stub = fetchStub();
    const { provider, captured } = fakeStt({ id: "needs-token", needsToken: true });
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, stt: provider }),
    );
    await act(() => result.current.startListening());
    expect(result.current.state).toBe("listening");
    expect(stub.calls).toEqual([{ url: "/api/token/needs-token", method: "POST", body: null }]);
    expect(captured.options?.getToken).toBeDefined();
  });

  it("returns to idle without a request when the transcript is empty", async () => {
    const stub = fetchStub();
    const { provider } = fakeStt({ stopText: "   " });
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, stt: provider }),
    );
    await act(() => result.current.startListening());
    await act(() => result.current.stopListening());
    expect(result.current.state).toBe("idle");
    expect(stub.calls).toEqual([]);
    expect(result.current.messages).toEqual([]);
  });

  it("enters the error state when the provider fails to start or reports an error", async () => {
    const stub = fetchStub();
    const failing = fakeStt({ failStart: true });
    const a = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, stt: failing.provider }),
    );
    await act(() => a.result.current.startListening());
    expect(a.result.current.state).toBe("error");
    expect(a.result.current.error).toBe("microphone denied");

    const erroring = fakeStt();
    const b = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, stt: erroring.provider }),
    );
    await act(() => b.result.current.startListening());
    act(() => erroring.captured.options?.onError(new Error("network down")));
    expect(b.result.current.state).toBe("error");
    expect(b.result.current.error).toBe("network down");
    expect(erroring.captured.aborted).toBe(true); // the provider is told to release the mic
    // A later send recovers through RESET.
    await act(() => b.result.current.sendText("typed instead"));
    expect(b.result.current.state).toBe("idle");
  });

  it("surfaces a failure during finalisation as an error and does not send a transcript", async () => {
    const stub = fetchStub();
    const stopResult = deferred<string>();
    const { provider } = fakeStt({ stopResult: stopResult.promise });
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, stt: provider }),
    );
    await act(() => result.current.startListening());
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.stopListening();
    });
    await waitFor(() => expect(result.current.state).toBe("transcribing"));
    await act(async () => {
      stopResult.reject(new Error("Speech recognition error: network"));
      await pending;
    });
    expect(result.current.state).toBe("error");
    expect(result.current.error).toMatch(/network/);
    expect(stub.calls).toEqual([]);
  });

  it("stop() and unmount abort a listening session", async () => {
    const stub = fetchStub();
    const first = fakeStt();
    const a = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, stt: first.provider }),
    );
    await act(() => a.result.current.startListening());
    act(() => first.captured.options?.onPartial("some"));
    act(() => a.result.current.stop());
    expect(first.captured.aborted).toBe(true);
    expect(a.result.current.state).toBe("idle");
    expect(a.result.current.interimTranscript).toBe("");
    expect(stub.calls).toEqual([]);

    const second = fakeStt();
    const b = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, stt: second.provider }),
    );
    await act(() => b.result.current.startListening());
    b.unmount();
    expect(second.captured.aborted).toBe(true);
  });

  it("honours a release that arrives while the provider is still starting", async () => {
    const stub = fetchStub();
    const gate = deferred<void>();
    const { provider, captured } = fakeStt({ startGate: gate.promise, stopText: "early words" });
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, stt: provider }),
    );

    let starting: Promise<void> | undefined;
    act(() => {
      starting = result.current.startListening();
    });
    expect(result.current.state).toBe("listening");
    // Released before start() resolved (e.g. still awaiting mic permission or a token).
    await act(() => result.current.stopListening());
    expect(captured.stopCalls).toBe(0);

    await act(async () => {
      gate.resolve();
      await starting;
    });
    expect(captured.stopCalls).toBe(1);
    expect(sentMessages(stub.calls[0])).toEqual([{ role: "user", content: "early words" }]);
    expect(result.current.state).toBe("idle");
  });

  it("stop() during provider startup aborts it and discards the session when it arrives", async () => {
    const stub = fetchStub();
    const gate = deferred<void>();
    const { provider, captured } = fakeStt({ startGate: gate.promise });
    const { result, unmount } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, stt: provider }),
    );

    let starting: Promise<void> | undefined;
    act(() => {
      starting = result.current.startListening();
    });
    act(() => result.current.stop());
    expect(result.current.state).toBe("idle");

    await act(async () => {
      gate.resolve();
      await starting;
    });
    expect(captured.aborted).toBe(true);
    expect(captured.stopCalls).toBe(1); // the late session is stopped, never used
    expect(stub.calls).toEqual([]);
    expect(result.current.state).toBe("idle");

    // Unmount during startup behaves the same.
    const gate2 = deferred<void>();
    const late = fakeStt({ startGate: gate2.promise });
    const b = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, stt: late.provider }),
    );
    let starting2: Promise<void> | undefined;
    act(() => {
      starting2 = b.result.current.startListening();
    });
    b.unmount();
    unmount();
    expect(late.captured.aborted).toBe(true);
    gate2.resolve();
    await starting2;
    expect(late.captured.stopCalls).toBe(1);
  });

  it("never submits the transcript of a cancelled finalisation, even if it resolves later", async () => {
    const stub = fetchStub();
    const firstStop = deferred<string>();
    const first = fakeStt({ stopResult: firstStop.promise });
    const { result, rerender } = renderHook(
      ({ stt }) => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, stt }),
      { initialProps: { stt: first.provider } },
    );

    await act(() => result.current.startListening());
    let firstRelease: Promise<void> | undefined;
    act(() => {
      firstRelease = result.current.stopListening();
    });
    await waitFor(() => expect(result.current.state).toBe("transcribing"));
    act(() => result.current.stop()); // cancel while finalising
    expect(result.current.state).toBe("idle");
    expect(first.captured.aborted).toBe(true);

    // Second recording with a fresh provider completes normally.
    const second = fakeStt({ stopText: "second" });
    rerender({ stt: second.provider });
    await act(() => result.current.startListening());
    await act(() => result.current.stopListening());
    expect(sentMessages(stub.calls[0])).toEqual([{ role: "user", content: "second" }]);

    // The cancelled operation resolves late: ignored.
    await act(async () => {
      firstStop.resolve("first");
      await firstRelease;
    });
    expect(stub.calls).toHaveLength(1);
    expect(result.current.messages.map((m) => m.text)).toEqual(["second", "reply"]);
    expect(result.current.state).toBe("idle");
  });

  it("reports a missing provider instead of starting, and ignores stopListening when idle", async () => {
    const stub = fetchStub();
    const { result } = renderHook(() => useVoiceChat({ baseUrl: "/api", fetch: stub.fetch }));
    expect(result.current.sttProviderId).toBeNull();
    await act(() => result.current.startListening());
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toMatch(/No speech-to-text provider/);
    await act(() => result.current.stopListening());
    expect(result.current.state).toBe("idle");
    await waitFor(() => expect(stub.calls).toEqual([]));
  });
});
