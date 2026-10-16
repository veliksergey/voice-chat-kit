// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { deepgramStt } from "./deepgram.js";

type Listener = (event: unknown) => void;

/** Scripted stand-in for the browser WebSocket. */
class FakeWebSocket {
  static instances: FakeWebSocket[] = [];
  static OPEN = 1;
  readyState = 0;
  sent: unknown[] = [];
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
  send(data: unknown): void {
    this.sent.push(data);
  }
  close(code?: number, reason?: string): void {
    this.closeCalls.push([code, reason]);
    // A close during CONNECTING cancels the attempt; in both cases the socket ends CLOSED.
    this.serverClose(1000);
  }
  // test controls
  open(): void {
    this.readyState = 1;
    this.onopen?.({});
  }
  message(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) });
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

class FakeMediaRecorder {
  static instances: FakeMediaRecorder[] = [];
  static supported = new Set(["audio/webm;codecs=opus", "audio/webm"]);
  static throwOnConstruct = false;
  static isTypeSupported(type: string): boolean {
    return FakeMediaRecorder.supported.has(type);
  }
  state: "inactive" | "recording" = "inactive";
  timeslice: number | undefined;
  ondataavailable: ((event: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  /** Emits the documented failure sequence: error, then the last data, then stop. */
  error(): void {
    this.onerror?.({ error: new Error("encoder failure") });
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([]) });
    queueMicrotask(() => this.onstop?.());
  }

  constructor(
    public stream: unknown,
    public options?: { mimeType?: string },
  ) {
    if (FakeMediaRecorder.throwOnConstruct) throw new Error("NotSupportedError: bad mimeType");
    FakeMediaRecorder.instances.push(this);
  }
  start(timeslice?: number): void {
    this.state = "recording";
    this.timeslice = timeslice;
  }
  stop(): void {
    if (this.state === "inactive") throw new Error("InvalidStateError");
    this.state = "inactive";
    // Like the real thing: the last chunk, then the stop event.
    this.ondataavailable?.({ data: new Blob(["tail"]) });
    queueMicrotask(() => this.onstop?.());
  }
  chunk(bytes: string): void {
    this.ondataavailable?.({ data: new Blob([bytes]) });
  }
}

const g = globalThis as Record<string, unknown>;
let tracksStopped = 0;

function installBrowser(): void {
  g.WebSocket = FakeWebSocket;
  g.MediaRecorder = FakeMediaRecorder;
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: async () => ({
        getTracks: () => [
          {
            stop: () => {
              tracksStopped += 1;
            },
          },
        ],
      }),
    },
  });
}

afterEach(() => {
  FakeWebSocket.instances = [];
  FakeMediaRecorder.instances = [];
  FakeMediaRecorder.throwOnConstruct = false;
  tracksStopped = 0;
  g.WebSocket = undefined;
  g.MediaRecorder = undefined;
});

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

function harness(tokenGate?: Promise<void>) {
  const partials: string[] = [];
  const finals: string[] = [];
  const errors: string[] = [];
  const controller = new AbortController();
  let tokenRequests = 0;
  return {
    partials,
    finals,
    errors,
    controller,
    tokenRequests: () => tokenRequests,
    options: {
      language: "en-US",
      getToken: async () => {
        tokenRequests += 1;
        if (tokenGate) await tokenGate;
        return { token: "jwt.secret", expiresAt: Date.now() + 60_000 };
      },
      onPartial: (t: string) => partials.push(t),
      onFinal: (t: string) => finals.push(t),
      onError: (e: Error) => errors.push(e.message),
      signal: controller.signal,
    },
  };
}

async function startAndOpen(h: ReturnType<typeof harness>, provider = deepgramStt()) {
  const starting = provider.start(h.options);
  await tick(); // mic + token resolve, socket constructed
  const socket = FakeWebSocket.instances[0];
  if (!socket) throw new Error("no socket");
  socket.open();
  const session = await starting;
  const recorder = FakeMediaRecorder.instances[0];
  if (!recorder) throw new Error("no recorder");
  return { session, socket, recorder };
}

describe("deepgramStt", () => {
  it("connects with the token in the subprotocol only, streams audio chunks, and maps results", async () => {
    installBrowser();
    const h = harness();
    const { session, socket, recorder } = await startAndOpen(h);

    const url = new URL(socket.url);
    expect(url.origin + url.pathname).toBe("wss://api.deepgram.com/v1/listen");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      model: "nova-3",
      language: "en-US",
      interim_results: "true",
      smart_format: "true",
    });
    expect(socket.url).not.toContain("jwt.secret");
    expect(socket.protocols).toEqual(["bearer", "jwt.secret"]);
    expect(h.tokenRequests()).toBe(1);
    expect(recorder.options).toEqual({ mimeType: "audio/webm;codecs=opus" });
    expect(recorder.timeslice).toBe(250);

    recorder.chunk("abc");
    expect(socket.sent).toHaveLength(1);
    expect(socket.sent[0]).toBeInstanceOf(Blob);

    socket.message({ type: "Metadata", request_id: "r1" });
    socket.message({
      type: "Results",
      is_final: false,
      channel: { alternatives: [{ transcript: "hello the" }] },
    });
    socket.message({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "Hello there." }] },
    });
    expect(h.partials).toEqual(["hello the", ""]);
    expect(h.finals).toEqual(["Hello there."]);

    const stopping = session.stop();
    await tick();
    // Recorder stopped, its tail chunk sent, then CloseStream.
    expect(recorder.state).toBe("inactive");
    expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "CloseStream" }));
    socket.message({
      type: "Results",
      is_final: true,
      channel: { alternatives: [{ transcript: "How are you?" }] },
    });
    socket.serverClose(1000);
    expect(await stopping).toBe("Hello there. How are you?");
    expect(tracksStopped).toBeGreaterThan(0);
    expect(h.errors).toEqual([]);
  });

  it("resolves stop() after the close timeout if Deepgram never closes", async () => {
    installBrowser();
    const h = harness();
    const { session, socket } = await startAndOpen(h, deepgramStt({ closeTimeoutMs: 20 }));
    socket.message({
      type: "Results",
      is_final: false,
      channel: { alternatives: [{ transcript: "pending words" }] },
    });
    expect(await session.stop()).toBe("pending words");
    expect(socket.closeCalls.length).toBe(1);
    expect(tracksStopped).toBeGreaterThan(0);
  });

  it("aborting the signal stops the recorder, the tracks, and the socket without an error", async () => {
    installBrowser();
    const h = harness();
    const { session, socket, recorder } = await startAndOpen(h);
    h.controller.abort();
    await tick();
    expect(recorder.state).toBe("inactive");
    expect(tracksStopped).toBeGreaterThan(0);
    expect(socket.readyState).toBe(3);
    expect(h.errors).toEqual([]);
    expect(await session.stop()).toBe("");
  });

  it("tears down capture after a Deepgram error, a socket error, or an abnormal close", async () => {
    installBrowser();
    const a = harness();
    const first = await startAndOpen(a);
    first.socket.message({ type: "Error", description: "bad audio", code: "E1" });
    expect(a.errors).toEqual(["Deepgram error: bad audio"]);
    expect(first.recorder.state).toBe("inactive");
    expect(tracksStopped).toBe(1);
    expect(first.socket.readyState).toBe(3);
    FakeWebSocket.instances = [];
    FakeMediaRecorder.instances = [];

    const b = harness();
    const second = await startAndOpen(b);
    second.socket.serverClose(1011);
    expect(b.errors).toEqual(["Deepgram connection closed (1011)"]);
    expect(second.recorder.state).toBe("inactive");
    expect(tracksStopped).toBe(2);
    FakeWebSocket.instances = [];
    FakeMediaRecorder.instances = [];

    const c = harness();
    const third = await startAndOpen(c);
    third.socket.fail();
    expect(c.errors).toEqual(["Deepgram connection error"]);
    expect(third.recorder.state).toBe("inactive");
    expect(tracksStopped).toBe(3);
  });

  it("rejects stop() when a failure happens while the final results are awaited", async () => {
    installBrowser();
    const h = harness();
    const { session, socket, recorder } = await startAndOpen(h);
    socket.message({
      type: "Results",
      is_final: false,
      channel: { alternatives: [{ transcript: "half a" }] },
    });
    const stopping = session.stop();
    await tick();
    socket.serverClose(1011); // Deepgram dies before flushing finals
    await expect(stopping).rejects.toThrow(/closed \(1011\)/);
    expect(h.errors).toEqual([]); // reported through the rejection, not twice
    expect(recorder.state).toBe("inactive");
    expect(tracksStopped).toBeGreaterThan(0);
  });

  it("honours an abort while the token is pending: mic released, no socket, startup rejects", async () => {
    installBrowser();
    let releaseToken: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseToken = resolve;
    });
    const h = harness(gate);
    const starting = deepgramStt().start(h.options);
    await tick(); // mic acquired, token pending
    h.controller.abort();
    expect(tracksStopped).toBeGreaterThan(0);
    releaseToken?.();
    await expect(starting).rejects.toThrow(/cancelled/);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });

  it("aborting during the handshake closes the connecting socket and releases the mic", async () => {
    installBrowser();
    const h = harness();
    const starting = deepgramStt().start(h.options);
    await tick();
    const socket = FakeWebSocket.instances[0];
    expect(socket?.readyState).toBe(0);
    h.controller.abort();
    await expect(starting).rejects.toThrow(/cancelled/);
    expect(socket?.closeCalls).toHaveLength(1);
    expect(socket?.readyState).toBe(3);
    expect(tracksStopped).toBeGreaterThan(0);
    expect(FakeMediaRecorder.instances).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });

  it("fails to start when the socket cannot connect, releasing the microphone, reported once", async () => {
    installBrowser();
    const h = harness();
    const starting = deepgramStt().start(h.options);
    await tick();
    FakeWebSocket.instances[0]?.fail();
    await expect(starting).rejects.toThrow(/Could not connect to Deepgram/);
    expect(tracksStopped).toBeGreaterThan(0);
    expect(h.errors).toEqual([]);
  });

  it("releases the microphone and socket when the recorder cannot be created", async () => {
    installBrowser();
    FakeMediaRecorder.throwOnConstruct = true;
    const h = harness();
    const starting = deepgramStt().start(h.options);
    await tick();
    const socket = FakeWebSocket.instances[0];
    socket?.open();
    await expect(starting).rejects.toThrow(/NotSupportedError/);
    expect(tracksStopped).toBeGreaterThan(0);
    expect(socket?.readyState).toBe(3);
  });

  it("treats a clean close before stop() as a failure and releases capture", async () => {
    installBrowser();
    const h = harness();
    const { socket, recorder } = await startAndOpen(h);
    socket.serverClose(1000);
    expect(h.errors).toEqual(["Deepgram connection closed (1000)"]);
    expect(recorder.state).toBe("inactive");
    expect(tracksStopped).toBeGreaterThan(0);
  });

  it("routes asynchronous recorder errors to teardown, during capture and during stop()", async () => {
    installBrowser();
    const a = harness();
    const first = await startAndOpen(a);
    first.recorder.error();
    await tick();
    expect(a.errors).toEqual(["Recording failed"]);
    expect(tracksStopped).toBe(1);
    expect(first.socket.readyState).toBe(3);
    FakeWebSocket.instances = [];
    FakeMediaRecorder.instances = [];

    const b = harness();
    const second = await startAndOpen(b);
    // Fail while finishing: the recorder dies as stop() asks it to flush.
    second.recorder.stop = function stop(this: FakeMediaRecorder) {
      this.error();
    };
    await expect(second.session.stop()).rejects.toThrow(/Recording failed/);
    expect(b.errors).toEqual([]);
    expect(tracksStopped).toBe(2);
  });

  it("releases the microphone when the endpoint or socket cannot be constructed", async () => {
    installBrowser();
    const h = harness();
    await expect(deepgramStt({ endpoint: "not a url" }).start(h.options)).rejects.toThrow();
    expect(tracksStopped).toBeGreaterThan(0);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(h.errors).toEqual([]);
  });

  it("requires a token source and reports support only with the needed browser APIs", async () => {
    expect(deepgramStt().isSupported?.()).toBe(false);
    installBrowser();
    expect(deepgramStt().isSupported?.()).toBe(true);
    const h = harness();
    const { getToken: _omitted, ...withoutToken } = h.options;
    await expect(deepgramStt().start(withoutToken)).rejects.toThrow(/token source/);
    expect(deepgramStt().capabilities).toEqual({
      streaming: true,
      interimResults: true,
      runsInBrowser: true,
      needsToken: true,
    });
  });
});
