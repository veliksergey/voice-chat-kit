// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { deepgramTts, pcm16ToFloat32, splitForSpeak } from "./deepgram.js";

type Listener = (event: unknown) => void;

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  readyState = 0;
  binaryType = "blob";
  sent: string[] = [];
  closeCalls: Array<[number | undefined, string | undefined]> = [];
  onopen: Listener | null = null;
  onmessage: Listener | null = null;
  onerror: Listener | null = null;
  onclose: Listener | null = null;
  #listeners: Record<string, Listener[]> = {};
  constructor(
    public url: string,
    public protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type: string, listener: Listener): void {
    const listeners = this.#listeners[type] ?? [];
    listeners.push(listener);
    this.#listeners[type] = listeners;
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    this.serverClose(1000);
  }
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  json(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
  audio(samples: number[]): void {
    const bytes = new ArrayBuffer(samples.length * 2);
    const view = new DataView(bytes);
    for (const [i, s] of samples.entries()) view.setInt16(i * 2, s, true);
    this.onmessage?.({ data: bytes });
  }
  serverClose(code: number): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    const event = { code };
    this.onclose?.(event);
    for (const l of this.#listeners.close ?? []) l(event);
  }
  fail(): void {
    this.onerror?.({});
    for (const l of this.#listeners.error ?? []) l({});
  }
}

class FakeSource {
  buffer: FakeBuffer | null = null;
  startedAt: number | null = null;
  stopped = false;
  onended: (() => void) | null = null;
  connect(): void {}
  start(when: number): void {
    this.startedAt = when;
  }
  stop(): void {
    this.stopped = true;
  }
  end(): void {
    this.onended?.();
  }
}

class FakeBuffer {
  data: Float32Array;
  constructor(
    public length: number,
    public sampleRate: number,
  ) {
    this.data = new Float32Array(length);
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(): Float32Array {
    return this.data;
  }
}

class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  /** State a new context starts in; browsers may create one suspended outside a gesture. */
  static initialState: "running" | "suspended" = "running";
  state: "running" | "suspended" | "closed";
  resumeCalls = 0;
  currentTime = 0;
  destination = {};
  closed = false;
  sources: FakeSource[] = [];
  buffers: FakeBuffer[] = [];
  sampleRate: number;
  constructor(options?: { sampleRate?: number }) {
    this.sampleRate = options?.sampleRate ?? 44100;
    this.state = FakeAudioContext.initialState;
    FakeAudioContext.instances.push(this);
  }
  async resume(): Promise<void> {
    this.resumeCalls += 1;
    this.state = "running";
  }
  createBuffer(_channels: number, length: number, sampleRate: number): FakeBuffer {
    const buffer = new FakeBuffer(length, sampleRate);
    this.buffers.push(buffer);
    return buffer;
  }
  createBufferSource(): FakeSource {
    const source = new FakeSource();
    this.sources.push(source);
    return source;
  }
  async close(): Promise<void> {
    this.closed = true;
    this.state = "closed";
  }
}

const g = globalThis as Record<string, unknown>;
function install(): void {
  g.WebSocket = FakeWebSocket;
  g.AudioContext = FakeAudioContext;
}
afterEach(() => {
  vi.useRealTimers();
  FakeWebSocket.instances = [];
  FakeAudioContext.instances = [];
  FakeAudioContext.initialState = "running";
  g.WebSocket = undefined;
  g.AudioContext = undefined;
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

async function* sentences(list: string[]): AsyncGenerator<string> {
  for (const s of list) yield s;
}

function harness() {
  const events: string[] = [];
  const controller = new AbortController();
  let tokenRequests = 0;
  return {
    events,
    controller,
    tokenRequests: () => tokenRequests,
    options: {
      getToken: async () => {
        tokenRequests += 1;
        return { token: "jwt.tts", expiresAt: Date.now() + 60_000 };
      },
      signal: controller.signal,
      onStart: () => events.push("start"),
      onEnd: () => events.push("end"),
    },
  };
}

async function speakAndOpen(
  h: ReturnType<typeof harness>,
  list: string[],
  provider = deepgramTts(),
) {
  const speaking = provider.speak(sentences(list), h.options);
  await tick();
  const socket = FakeWebSocket.instances[0];
  if (!socket) throw new Error("no socket");
  socket.open();
  await tick();
  const ctx = FakeAudioContext.instances[0];
  if (!ctx) throw new Error("no audio context");
  return { speaking, socket, ctx };
}

describe("pcm16ToFloat32", () => {
  it("converts little-endian int16 to floats in [-1, 1) and ignores a trailing odd byte", () => {
    const bytes = new ArrayBuffer(5);
    const view = new DataView(bytes);
    view.setInt16(0, 32767, true);
    view.setInt16(2, -32768, true);
    const out = pcm16ToFloat32(bytes);
    expect(out.length).toBe(2);
    expect(out[0]).toBeCloseTo(0.99997, 4);
    expect(out[1]).toBe(-1);
  });
});

describe("splitForSpeak", () => {
  it("keeps short text, splits long text at the last space before the cap, hard-splits text without spaces", () => {
    expect(splitForSpeak("Hello.")).toEqual(["Hello."]);
    // The separator stays with the preceding part: Deepgram appends payloads to one buffer.
    expect(splitForSpeak("aaaa bbbb cccc", 9)).toEqual(["aaaa ", "bbbb cccc"]);
    expect(splitForSpeak("abcdefgh", 3)).toEqual(["abc", "def", "gh"]);
    expect(splitForSpeak("a".repeat(2001))).toEqual(["a".repeat(2000), "a"]);
    for (const text of ["aaaa bbbb cccc", "abcdefgh", "a b c d e f", " lead and trail "]) {
      expect(splitForSpeak(text, 4).join("")).toBe(text); // nothing lost or duplicated
      for (const part of splitForSpeak(text, 4)) expect(part.length).toBeLessThanOrEqual(4);
    }
    expect(splitForSpeak("\u{1F600}\u{1F600}", 3)).toEqual(["\u{1F600}", "\u{1F600}"]); // never between surrogates
  });
});

describe("deepgramTts", () => {
  it("connects with the token only in the subprotocol, sends Speak+Flush per sentence then Close, and plays PCM gaplessly", async () => {
    install();
    const h = harness();
    const { speaking, socket, ctx } = await speakAndOpen(h, ["Hello there.", "  ", "Bye."]);

    const url = new URL(socket.url);
    expect(url.origin + url.pathname).toBe("wss://api.deepgram.com/v1/speak");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: "aura-2-thalia-en",
      encoding: "linear16",
      sample_rate: "24000",
    });
    expect(socket.url).not.toContain("jwt.tts");
    expect(socket.protocols).toEqual(["bearer", "jwt.tts"]);
    expect(socket.binaryType).toBe("arraybuffer");
    expect(h.tokenRequests()).toBe(1);
    expect(ctx.sampleRate).toBe(24000);
    expect(socket.sent.map((s) => JSON.parse(s))).toEqual([
      { type: "Speak", text: "Hello there." },
      { type: "Flush" },
      { type: "Speak", text: "Bye." },
      { type: "Flush" },
      { type: "Close" },
    ]);

    socket.json({ type: "Metadata", request_id: "r" });
    socket.audio(new Array(2400).fill(1000)); // 0.1 s
    socket.audio(new Array(4800).fill(-1000)); // 0.2 s
    socket.json({ type: "Flushed", sequence_id: 0 });
    socket.json({ type: "Flushed", sequence_id: 1 }); // one acknowledgement per Flush sent
    socket.json({ type: "Warning", description: "ignored", code: "W" });
    expect(h.events).toEqual(["start"]);
    expect(ctx.buffers.map((b) => b.length)).toEqual([2400, 4800]);
    expect(ctx.buffers[0]?.data[0]).toBeCloseTo(1000 / 32768, 6);
    const [first, second] = ctx.sources;
    expect(first?.startedAt).toBeCloseTo(0.02, 6);
    expect(second?.startedAt).toBeCloseTo(0.02 + 0.1, 6); // back-to-back, no gap

    socket.serverClose(1000); // Deepgram closes after Close once all audio is sent
    let done = false;
    void speaking.then(() => {
      done = true;
    });
    await tick();
    expect(done).toBe(false); // audio still playing
    first?.end();
    second?.end();
    await speaking;
    expect(h.events).toEqual(["start", "end"]);
    expect(ctx.closed).toBe(true);
  });

  it("creates the AudioContext synchronously at speak(), before any network wait, and resumes it if suspended", async () => {
    install();
    FakeAudioContext.initialState = "suspended";
    const h = harness();
    let releaseToken: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const speaking = deepgramTts().speak(sentences(["Hi."]), {
      ...h.options,
      getToken: async () => {
        await gate;
        return { token: "jwt.tts", expiresAt: Date.now() + 60_000 };
      },
    });
    // Still inside the caller's gesture: no await has happened yet.
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeWebSocket.instances).toHaveLength(0);
    const ctx = FakeAudioContext.instances[0];
    expect(ctx?.resumeCalls).toBe(1);
    expect(ctx?.state).toBe("running");
    releaseToken?.();
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(1);
    h.controller.abort();
    await speaking;
    expect(ctx?.closed).toBe(true);
  });

  it("abort while the token request is stalled passes the signal on, closes the context, and resolves", async () => {
    install();
    const controller = new AbortController();
    let seen: AbortSignal | undefined;
    const speaking = deepgramTts().speak(sentences(["Hi."]), {
      getToken: (signal) => {
        seen = signal;
        return new Promise(() => undefined); // never settles
      },
      signal: controller.signal,
    });
    await tick();
    expect(FakeWebSocket.instances).toHaveLength(0);
    controller.abort();
    await speaking; // would hang if the token wait were not raced against abort
    expect(seen?.aborted).toBe(true);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it("chains buffers back-to-back while audio is queued and re-leads only after an underrun", async () => {
    install();
    const h = harness();
    const { speaking, socket, ctx } = await speakAndOpen(h, ["One.", "Two."]);
    socket.audio(new Array(2400).fill(1)); // 0.1 s, clock at 0 -> leads by 20 ms
    ctx.currentTime = 0.11; // only 10 ms of queued audio left: a fixed lead would open a gap
    socket.audio(new Array(2400).fill(1)); // still ahead of the clock -> starts exactly when it ends
    ctx.currentTime = 0.5;
    socket.audio(new Array(2400).fill(1)); // the queue ran dry -> lead again, never in the past
    const starts = ctx.sources.map((s) => s.startedAt ?? Number.NaN);
    expect(starts[0]).toBeCloseTo(0.02, 6);
    expect(starts[1]).toBeCloseTo(0.12, 6);
    expect(starts[2]).toBeCloseTo(0.52, 6);
    h.controller.abort();
    await speaking;
  });

  it("a clean close before every flush was acknowledged rejects instead of passing as success", async () => {
    install();
    const h = harness();
    const { speaking, socket, ctx } = await speakAndOpen(h, ["One.", "Two."]);
    socket.audio(new Array(2400).fill(1));
    socket.json({ type: "Flushed", sequence_id: 0 }); // only the first of two flushes
    ctx.sources[0]?.end();
    socket.serverClose(1000); // Deepgram closes cleanly although the second sentence never came
    await expect(speaking).rejects.toThrow(/1 of 2 flushes acknowledged/);
    expect(h.events).toEqual(["start"]);
    expect(ctx.closed).toBe(true);
  });

  it("splits a sentence over Deepgram's 2,000-character payload cap into several Speak messages under one Flush", async () => {
    install();
    const h = harness();
    const long = Array.from({ length: 401 }, (_, i) => `w${String(i).padStart(3, "0")}`).join(" ");
    expect(long.length).toBe(2004);
    const { speaking, socket } = await speakAndOpen(h, [long]);
    const sent = socket.sent.map((s) => JSON.parse(s) as { type: string; text?: string });
    const speaks = sent.filter((m) => m.type === "Speak");
    expect(speaks.length).toBeGreaterThan(1);
    for (const m of speaks) expect((m.text ?? "").length).toBeLessThanOrEqual(2000);
    // Deepgram concatenates the payloads as sent, so they must reproduce the text verbatim.
    expect(speaks.map((m) => m.text).join("")).toBe(long); // joined with a space before the fix
    expect(sent.map((m) => m.type)).toEqual([...speaks.map(() => "Speak"), "Flush", "Close"]);
    h.controller.abort();
    await speaking;
  });

  it("paces Speak text to Deepgram's 2,400-characters-per-minute cap, keeping sentence and Flush boundaries", async () => {
    vi.useFakeTimers();
    install();
    const h = harness();
    const big = (n: number): string => `${"a".repeat(n - 1)}.`;
    const speaking = deepgramTts({ closeTimeoutMs: 120_000 }).speak(
      sentences([big(1001), big(1001), big(1001)]),
      h.options,
    );
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    const types = (): string[] => socket.sent.map((s) => (JSON.parse(s) as { type: string }).type);
    // 2,002 of 2,400 characters used: the third sentence must wait for the window.
    expect(types()).toEqual(["Speak", "Flush", "Speak", "Flush"]); // all three went at once before the fix
    await vi.advanceTimersByTimeAsync(59_000);
    expect(types()).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(1_100);
    expect(types()).toEqual(["Speak", "Flush", "Speak", "Flush", "Speak", "Flush", "Close"]);
    h.controller.abort();
    await speaking;
  });

  it("abort during a throughput wait resolves at once and sends nothing more", async () => {
    vi.useFakeTimers();
    install();
    const h = harness();
    const big = (n: number): string => `${"a".repeat(n - 1)}.`;
    const speaking = deepgramTts().speak(sentences([big(1001), big(1001), big(1001)]), h.options);
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(socket.sent).toHaveLength(4);
    h.controller.abort();
    await speaking; // would otherwise sit in the throughput wait
    await vi.advanceTimersByTimeAsync(120_000);
    expect(socket.sent).toHaveLength(4);
    expect(socket.readyState).toBe(3);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it("paces Flush to Deepgram's 20-per-60-s limit: text keeps flowing, one deferred Flush fires when the window frees", async () => {
    vi.useFakeTimers();
    install();
    const h = harness();
    let release: (() => void) | undefined;
    const open = new Promise<void>((resolve) => {
      release = resolve;
    });
    const feed = (async function* () {
      for (let i = 0; i < 22; i++) yield `Sentence ${i}.`;
      await open; // the reply is still streaming
    })();
    const speaking = deepgramTts().speak(feed, h.options);
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    const types = (): string[] => socket.sent.map((s) => (JSON.parse(s) as { type: string }).type);
    expect(types().filter((t) => t === "Speak")).toHaveLength(22); // text is never held back
    expect(types().filter((t) => t === "Flush")).toHaveLength(20); // 22 before the fix
    expect(types()).not.toContain("Close");
    const speakTexts = socket.sent
      .map((s) => JSON.parse(s) as { type: string; text?: string })
      .filter((m) => m.type === "Speak")
      .map((m) => m.text ?? "");
    expect(speakTexts[20]).toBe("Sentence 20."); // buffer was empty: flush 19 had gone out
    expect(speakTexts[21]).toBe(" Sentence 21."); // flush 20 deferred: keep the sentences apart

    await vi.advanceTimersByTimeAsync(59_000);
    expect(types().filter((t) => t === "Flush")).toHaveLength(20); // window not over yet
    await vi.advanceTimersByTimeAsync(1_100);
    expect(types().filter((t) => t === "Flush")).toHaveLength(21); // the deferred flush, once

    h.controller.abort();
    release?.();
    await speaking;
    await vi.advanceTimersByTimeAsync(120_000);
    expect(types().filter((t) => t === "Flush")).toHaveLength(21); // nothing after teardown
  });

  it("Close supersedes a deferred Flush when the reply ends while the budget is exhausted", async () => {
    vi.useFakeTimers();
    install();
    const h = harness();
    const list = Array.from({ length: 21 }, (_, i) => `Sentence ${i}.`);
    // The fake Deepgram never closes, so keep the adapter's close timeout out of this window.
    const speaking = deepgramTts({ closeTimeoutMs: 120_000 }).speak(sentences(list), h.options);
    await vi.advanceTimersByTimeAsync(0);
    const socket = FakeWebSocket.instances[0];
    if (!socket) throw new Error("no socket");
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    const types = (): string[] => socket.sent.map((s) => (JSON.parse(s) as { type: string }).type);
    expect(types().filter((t) => t === "Flush")).toHaveLength(20);
    expect(types().at(-1)).toBe("Close"); // flushes the 21st sentence itself
    await vi.advanceTimersByTimeAsync(61_000);
    expect(types().filter((t) => t === "Flush")).toHaveLength(20); // no late flush after Close
    h.controller.abort();
    await speaking;
  });

  it("abort stops scheduled audio, closes socket and context, and resolves silently", async () => {
    install();
    const h = harness();
    const { speaking, socket, ctx } = await speakAndOpen(h, ["A long sentence."]);
    socket.audio(new Array(24000).fill(500));
    expect(ctx.sources).toHaveLength(1);
    h.controller.abort();
    await speaking;
    expect(ctx.sources[0]?.stopped).toBe(true);
    expect(socket.readyState).toBe(3);
    expect(ctx.closed).toBe(true);
    expect(h.events).toEqual(["start"]); // no onEnd on cancellation
  });

  it("rejects when the socket closes before the text is complete or on a Deepgram error", async () => {
    install();
    const a = harness();
    const slow = (async function* () {
      yield "First.";
      await new Promise(() => undefined); // reply never completes
    })();
    const speakingA = deepgramTts().speak(slow, a.options);
    await tick();
    const socketA = FakeWebSocket.instances[0];
    socketA?.open();
    await tick();
    socketA?.serverClose(1011);
    await expect(speakingA).rejects.toThrow(/closed \(1011\)/);
    FakeWebSocket.instances = [];
    FakeAudioContext.instances = [];

    const b = harness();
    const { speaking, socket, ctx } = await speakAndOpen(b, ["Hi."]);
    socket.json({ type: "Error", description: "voice unavailable" });
    await expect(speaking).rejects.toThrow(/voice unavailable/);
    expect(ctx.closed).toBe(true);
  });

  it("rejects and tears down after the close timeout if Deepgram never closes the socket", async () => {
    install();
    const h = harness();
    const { speaking, socket, ctx } = await speakAndOpen(
      h,
      ["Hi."],
      deepgramTts({ closeTimeoutMs: 20 }),
    );
    // No audio ever arrives: calling this a success would hide a lost reply.
    await expect(speaking).rejects.toThrow(/did not finish within 20 ms/);
    expect(h.events).toEqual([]);
    expect(socket.readyState).toBe(3);
    expect(ctx.closed).toBe(true);
  });

  it("uses the requested voice and sample rate, and fails to connect cleanly", async () => {
    install();
    const h = harness();
    const speaking = deepgramTts({ sampleRate: 16000 }).speak(sentences(["x"]), {
      ...h.options,
      voice: "aura-2-orion-en",
    });
    await tick();
    const socket = FakeWebSocket.instances[0];
    expect(new URL(socket?.url ?? "").searchParams.get("model")).toBe("aura-2-orion-en");
    expect(new URL(socket?.url ?? "").searchParams.get("sample_rate")).toBe("16000");
    socket?.fail();
    await expect(speaking).rejects.toThrow(/Could not connect/);
    // The context was created up front (gesture) and is released on the failed start.
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(FakeAudioContext.instances[0]?.closed).toBe(true);
  });

  it("requires a token source and reports support only with WebSocket and Web Audio", async () => {
    expect(deepgramTts().isSupported?.()).toBe(false);
    install();
    expect(deepgramTts().isSupported?.()).toBe(true);
    await expect(
      deepgramTts().speak(sentences(["x"]), { signal: new AbortController().signal }),
    ).rejects.toThrow(/token source/);
    expect(deepgramTts().capabilities).toEqual({
      streamingInput: true,
      runsInBrowser: true,
      needsToken: true,
    });
  });
});
