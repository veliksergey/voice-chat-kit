// @vitest-environment jsdom
import { act, renderHook, waitFor } from "@testing-library/react";
import type {
  SttProvider,
  SttSession,
  SttStartOptions,
  TtsProvider,
  TtsSpeakOptions,
} from "@voice-chat-kit/core";
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
const REPLY = sse([
  { event: "text", data: { delta: "Hello there. How are" } },
  { event: "text", data: { delta: " you? Fine." } },
  DONE,
]);

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

function fetchStub(responder: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: string[] = [];
  const bodies: unknown[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = String(input);
    calls.push(`${init?.method ?? "GET"} ${url}`);
    bodies.push(typeof init?.body === "string" ? JSON.parse(init.body) : null);
    return responder(url, init);
  };
  return { fetch, calls, bodies };
}
const stream = (text: string): Response =>
  new Response(text, { status: 200, headers: { "content-type": "text/event-stream" } });
/**
 * A reply whose body delivers `text` and then stays open until the request is aborted, failing
 * the pending read the way a real fetch does. Its rejection reaches the hook only after the
 * caller that aborted it has moved on, which is the window the barge regressions cover.
 */
function unfinishedStream(text: string, signal: AbortSignal | null | undefined): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(text));
      signal?.addEventListener(
        "abort",
        () => controller.error(new DOMException("The operation was aborted.", "AbortError")),
        { once: true },
      );
    },
  });
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

interface FakeTtsConfig {
  id?: string;
  needsToken?: boolean;
  /** Resolves playback after the text ended; speak() waits for it unless aborted. */
  playback?: Deferred<void>;
  failWith?: Error;
}

/** Scripted TTS provider: records the sentences it receives and when it was aborted. */
function fakeTts(config: FakeTtsConfig = {}) {
  const received: string[] = [];
  const state = {
    aborted: false,
    speakCalls: 0,
    voice: undefined as string | undefined,
    signals: [] as AbortSignal[],
  };
  const provider: TtsProvider = {
    id: config.id ?? "fake-tts",
    capabilities: {
      streamingInput: true,
      runsInBrowser: true,
      needsToken: config.needsToken ?? false,
    },
    async speak(sentences: AsyncIterable<string>, options: TtsSpeakOptions): Promise<void> {
      state.speakCalls += 1;
      state.voice = options.voice;
      state.signals.push(options.signal);
      if (options.getToken) await options.getToken();
      options.signal.addEventListener("abort", () => {
        state.aborted = true;
      });
      let first = true;
      for await (const sentence of sentences) {
        received.push(sentence);
        if (first) {
          first = false;
          options.onStart?.();
        }
      }
      if (config.failWith) throw config.failWith;
      if (config.playback && !options.signal.aborted) {
        await Promise.race([
          config.playback.promise,
          new Promise<void>((resolve) =>
            options.signal.addEventListener("abort", () => resolve(), { once: true }),
          ),
        ]);
      }
      if (!options.signal.aborted) options.onEnd?.();
    },
  };
  return { provider, received, state };
}

function fakeStt() {
  const captured: { options?: SttStartOptions } = {};
  const provider: SttProvider = {
    id: "fake-stt",
    capabilities: { streaming: true, interimResults: true, runsInBrowser: true, needsToken: false },
    async start(options: SttStartOptions): Promise<SttSession> {
      captured.options = options;
      return { stop: async () => "spoken" };
    },
  };
  return { provider, captured };
}

describe("useVoiceChat speaking (text-to-speech)", () => {
  it("speaks completed sentences while the reply streams and goes idle when playback ends", async () => {
    const stub = fetchStub(() => stream(REPLY));
    const playback = deferred<void>();
    const tts = fakeTts({ playback });
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, tts: tts.provider, voice: "nova" }),
    );
    expect(result.current.ttsProviderId).toBe("fake-tts");

    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.sendText("hi");
    });
    await waitFor(() => expect(result.current.state).toBe("speaking"));
    await waitFor(() => expect(tts.received).toEqual(["Hello there.", "How are you?", "Fine."]));
    expect(tts.state.voice).toBe("nova");
    // Text is complete but speech is still playing.
    expect(result.current.messages[1]).toMatchObject({
      text: "Hello there. How are you? Fine.",
      status: "complete",
    });
    expect(result.current.state).toBe("speaking");

    await act(async () => {
      playback.resolve();
      await pending;
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBeNull();
    expect(tts.state.aborted).toBe(false);
  });

  it("stop() during speech aborts the provider and returns to idle, keeping the reply text", async () => {
    const stub = fetchStub(() => stream(REPLY));
    const tts = fakeTts({ playback: deferred<void>() });
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, tts: tts.provider }),
    );
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.sendText("hi");
    });
    await waitFor(() => expect(result.current.state).toBe("speaking"));
    act(() => result.current.stop());
    await act(async () => {
      await pending;
    });
    expect(tts.state.aborted).toBe(true);
    expect(result.current.state).toBe("idle");
    expect(result.current.messages[1]).toMatchObject({ status: "complete" });
  });

  it("a terminal refusal cancels queued speech", async () => {
    const stub = fetchStub(() =>
      stream(
        sse([
          { event: "text", data: { delta: "First sentence. Second" } },
          { event: "refusal", data: { category: "cyber", explanation: null } },
        ]),
      ),
    );
    const tts = fakeTts({ playback: deferred<void>() });
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, tts: tts.provider }),
    );
    await act(() => result.current.sendText("hi"));
    expect(tts.state.aborted).toBe(true);
    expect(result.current.lastRefusal).toEqual({ category: "cyber", explanation: null });
    expect(result.current.state).toBe("idle");
  });

  it("pressing to talk or typing while speaking cancels speech first (barge by button)", async () => {
    const stub = fetchStub(() => stream(REPLY));
    const tts = fakeTts({ playback: deferred<void>() });
    const stt = fakeStt();
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, tts: tts.provider, stt: stt.provider }),
    );
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.sendText("hi");
    });
    await waitFor(() => expect(result.current.state).toBe("speaking"));

    await act(() => result.current.startListening());
    expect(tts.state.aborted).toBe(true);
    expect(result.current.state).toBe("listening");
    await act(async () => {
      await pending;
    });
    expect(result.current.state).toBe("listening"); // the old turn did not disturb the new one
    act(() => result.current.stop());
    expect(result.current.state).toBe("idle");
  });

  it("a barge while the reply is still streaming does not let the old turn cancel the new session", async () => {
    // Press-to-talk over an unfinished reply: the cancelled request's cleanup arrives after the
    // new listening session exists and must leave it (and the state) alone.
    let chatCalls = 0;
    const stub = fetchStub((_url, init) => {
      chatCalls += 1;
      return chatCalls === 1
        ? unfinishedStream(
            sse([{ event: "text", data: { delta: "Hello there. How" } }]),
            init?.signal,
          )
        : stream(REPLY);
    });
    const playback = deferred<void>();
    const tts = fakeTts({ playback });
    const stt = fakeStt();
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, tts: tts.provider, stt: stt.provider }),
    );
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.sendText("hi");
    });
    await waitFor(() => expect(result.current.state).toBe("speaking"));

    await act(() => result.current.startListening());
    await act(async () => {
      await pending; // the old request's AbortError is handled here, after the new session began
    });
    expect(tts.state.aborted).toBe(true);
    expect(result.current.state).toBe("listening");
    expect(result.current.messages[1]).toMatchObject({
      text: "Hello there. How",
      status: "complete",
    });
    // The microphone still belongs to the new session: releasing it transcribes and sends a turn.
    let next: Promise<void> | undefined;
    act(() => {
      next = result.current.stopListening();
    });
    await waitFor(() => expect(result.current.state).toBe("speaking"));
    expect(result.current.messages[2]).toMatchObject({ role: "user", text: "spoken" });
    // The interrupted reply is part of the history the new turn replays.
    expect(stub.bodies[1]).toEqual({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Hello there. How" },
        { role: "user", content: "spoken" },
      ],
    });
    await act(async () => {
      playback.resolve();
      await next;
    });
    expect(result.current.state).toBe("idle");
  });

  it("typing over an unfinished spoken reply keeps the new reply's speech alive", async () => {
    let chatCalls = 0;
    const stub = fetchStub((_url, init) => {
      chatCalls += 1;
      return chatCalls === 1
        ? unfinishedStream(
            sse([{ event: "text", data: { delta: "Old reply. More" } }]),
            init?.signal,
          )
        : stream(REPLY);
    });
    const playback = deferred<void>();
    const tts = fakeTts({ playback });
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, tts: tts.provider }),
    );
    let first: Promise<void> | undefined;
    act(() => {
      first = result.current.sendText("hi");
    });
    await waitFor(() => expect(result.current.state).toBe("speaking"));

    let second: Promise<void> | undefined;
    act(() => {
      second = result.current.sendText("again");
    });
    await act(async () => {
      await first; // old request fails with AbortError while the new turn is already running
    });
    await waitFor(() => expect(tts.received).toContain("Fine."));
    // The reply the user interrupted was finalised before the new request was built, so Claude
    // sees what was actually said; without that the request held only the two user messages.
    expect(stub.bodies[1]).toEqual({
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "Old reply. More" },
        { role: "user", content: "again" },
      ],
    });
    expect(tts.state.signals).toHaveLength(2);
    expect(tts.state.signals[0]?.aborted).toBe(true);
    expect(tts.state.signals[1]?.aborted).toBe(false); // the stale turn did not silence this one
    expect(result.current.state).toBe("speaking");
    await act(async () => {
      playback.resolve();
      await second;
    });
    expect(result.current.state).toBe("idle");
    expect(result.current.messages.map((m) => m.status)).toEqual([
      "complete",
      "complete",
      "complete",
      "complete",
    ]);
  });

  it("a provider whose speak() throws synchronously is still a notice, not a failed turn", async () => {
    const stub = fetchStub(() => stream(REPLY));
    const throwing: TtsProvider = {
      id: "throwing-tts",
      capabilities: { streamingInput: true, runsInBrowser: true, needsToken: false },
      speak() {
        throw new Error("no audio device");
      },
    };
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, tts: throwing }),
    );
    await act(() => result.current.sendText("hi")); // rejected and left `thinking` before the fix
    expect(stub.calls).toContain("POST /api/chat");
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBe("Speech failed: no audio device");
    expect(result.current.messages.map((m) => m.status)).toEqual(["complete", "complete"]);
  });

  it("a speech failure is a notice, not a failed turn", async () => {
    const stub = fetchStub(() => stream(REPLY));
    const tts = fakeTts({ failWith: new Error("voice unavailable") });
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, tts: tts.provider }),
    );
    await act(() => result.current.sendText("hi"));
    expect(result.current.state).toBe("idle");
    expect(result.current.error).toBe("Speech failed: voice unavailable");
    expect(result.current.messages.map((m) => m.status)).toEqual(["complete", "complete"]);
  });

  it("fetches a token for TTS providers that need one", async () => {
    const stub = fetchStub((url) =>
      url.endsWith("/token/dg-tts")
        ? new Response(JSON.stringify({ token: "jwt", expiresAt: 1_900_000_000_000 }), {
            status: 200,
          })
        : stream(REPLY),
    );
    const tts = fakeTts({ id: "dg-tts", needsToken: true });
    const { result } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, tts: tts.provider }),
    );
    await act(() => result.current.sendText("hi"));
    expect(stub.calls).toContain("POST /api/token/dg-tts");
    expect(result.current.state).toBe("idle");
  });

  it("unmount aborts speech", async () => {
    const stub = fetchStub(() => stream(REPLY));
    const tts = fakeTts({ playback: deferred<void>() });
    const { result, unmount } = renderHook(() =>
      useVoiceChat({ baseUrl: "/api", fetch: stub.fetch, tts: tts.provider }),
    );
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.sendText("hi");
    });
    await waitFor(() => expect(result.current.state).toBe("speaking"));
    unmount();
    await pending;
    expect(tts.state.aborted).toBe(true);
  });
});
