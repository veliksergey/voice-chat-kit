// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { webSpeechStt } from "./web-speech.js";

type Handler<T> = ((event: T) => void) | null;
type Entry = [transcript: string, isFinal: boolean];

/**
 * Scripted stand-in for the browser's SpeechRecognition. Like the real API, `results` is
 * cumulative and `resultIndex` marks the first result that changed in this event.
 */
class FakeRecognition {
  static instances: FakeRecognition[] = [];
  lang = "";
  continuous = false;
  interimResults = false;
  started = false;
  stopped = false;
  aborted = false;
  onresult: Handler<unknown> = null;
  onerror: Handler<{ error: string }> = null;
  onend: (() => void) | null = null;
  #results: Entry[] = [];

  constructor() {
    FakeRecognition.instances.push(this);
  }
  start(): void {
    this.started = true;
  }
  stop(): void {
    this.stopped = true;
    queueMicrotask(() => this.onend?.());
  }
  abort(): void {
    this.aborted = true;
    queueMicrotask(() => {
      this.onerror?.({ error: "aborted" });
      this.onend?.();
    });
  }
  /** Replaces the results from `resultIndex` onward and fires onresult with the full list. */
  emit(resultIndex: number, entries: Entry[]): void {
    this.#results = [...this.#results.slice(0, resultIndex), ...entries];
    const results = this.#results.map(([transcript, isFinal]) => ({
      isFinal,
      length: 1,
      0: { transcript },
    }));
    this.onresult?.({ resultIndex, results: Object.assign(results, { length: results.length }) });
  }
}

const g = globalThis as Record<string, unknown>;

afterEach(() => {
  g.SpeechRecognition = undefined;
  g.webkitSpeechRecognition = undefined;
  FakeRecognition.instances = [];
});

function harness() {
  const partials: string[] = [];
  const finals: string[] = [];
  const errors: Error[] = [];
  const controller = new AbortController();
  return {
    partials,
    finals,
    errors,
    controller,
    options: {
      language: "en-US",
      onPartial: (t: string) => partials.push(t),
      onFinal: (t: string) => finals.push(t),
      onError: (e: Error) => errors.push(e),
      signal: controller.signal,
    },
  };
}

describe("webSpeechStt", () => {
  it("reports support only when a recognition constructor exists (prefixed or not)", () => {
    expect(webSpeechStt().isSupported?.()).toBe(false);
    g.webkitSpeechRecognition = FakeRecognition;
    expect(webSpeechStt().isSupported?.()).toBe(true);
    g.webkitSpeechRecognition = undefined;
    g.SpeechRecognition = FakeRecognition;
    expect(webSpeechStt().isSupported?.()).toBe(true);
    expect(webSpeechStt().capabilities).toEqual({
      streaming: true,
      interimResults: true,
      runsInBrowser: true,
      needsToken: false,
    });
  });

  it("streams interim text, reports each final once, and resolves the full transcript on stop", async () => {
    g.SpeechRecognition = FakeRecognition;
    const h = harness();
    const session = await webSpeechStt().start(h.options);
    const rec = FakeRecognition.instances[0];
    if (!rec) throw new Error("no recognition");
    expect(rec).toMatchObject({
      started: true,
      continuous: true,
      interimResults: true,
      lang: "en-US",
    });

    rec.emit(0, [["hel", false]]);
    rec.emit(0, [["hello", false]]);
    rec.emit(0, [["hello there.", true]]);
    rec.emit(1, [["how are", false]]);
    rec.emit(1, [["how are you", false]]); // the final at index 0 is re-sent but not re-reported
    expect(h.partials).toEqual(["hel", "hello", "", "how are", "how are you"]);
    expect(h.finals).toEqual(["hello there."]);

    const text = await session.stop();
    expect(rec.stopped).toBe(true);
    expect(text).toBe("hello there. how are you");
    expect(h.errors).toEqual([]);
  });

  it("aborting the signal aborts recognition without reporting an error", async () => {
    g.SpeechRecognition = FakeRecognition;
    const h = harness();
    const session = await webSpeechStt().start(h.options);
    const rec = FakeRecognition.instances[0];
    h.controller.abort();
    await new Promise((r) => setTimeout(r, 0));
    expect(rec?.aborted).toBe(true);
    expect(h.errors).toEqual([]);
    expect(await session.stop()).toBe("");
  });

  it("surfaces recognition errors other than aborted/no-speech", async () => {
    g.SpeechRecognition = FakeRecognition;
    const h = harness();
    await webSpeechStt().start(h.options);
    const rec = FakeRecognition.instances[0];
    rec?.onerror?.({ error: "no-speech" });
    rec?.onerror?.({ error: "not-allowed" });
    expect(h.errors.map((e) => e.message)).toEqual(["Speech recognition error: not-allowed"]);
  });

  it("rejects stop() when a real error happens while finishing, instead of returning a partial transcript", async () => {
    g.SpeechRecognition = class extends FakeRecognition {
      override stop(): void {
        this.stopped = true;
        // The browser reports a failure before ending; nothing final ever arrives.
        queueMicrotask(() => {
          this.onerror?.({ error: "network" });
          this.onend?.();
        });
      }
    };
    const h = harness();
    const session = await webSpeechStt().start(h.options);
    FakeRecognition.instances[0]?.emit(0, [["half a sent", false]]);
    await expect(session.stop()).rejects.toThrow(/network/);
    expect(h.errors).toEqual([]); // reported through the rejection, not twice
  });

  it("restarts recognition when the browser ends it on its own while still held", async () => {
    g.SpeechRecognition = class extends FakeRecognition {
      starts = 0;
      override start(): void {
        this.starts += 1;
        this.started = true;
      }
    };
    const h = harness();
    const session = await webSpeechStt().start(h.options);
    const rec = FakeRecognition.instances[0] as (FakeRecognition & { starts: number }) | undefined;
    if (!rec) throw new Error("no recognition");

    rec.emit(0, [["first part.", true]]);
    // Silence timeout: the browser fires `end` without anyone calling stop().
    rec.onerror?.({ error: "no-speech" });
    rec.onend?.();
    expect(rec.starts).toBe(2);
    expect(h.errors).toEqual([]);

    // The new run reports results from index 0 again; they are new finals, not duplicates.
    rec.emit(0, [["second part.", true]]);
    rec.emit(1, [["and more", false]]);
    expect(h.finals).toEqual(["first part.", "second part."]);

    expect(await session.stop()).toBe("first part. second part. and more");
    expect(rec.starts).toBe(2); // graceful stop does not restart
  });

  it("does not restart after a real error has been reported", async () => {
    g.SpeechRecognition = class extends FakeRecognition {
      starts = 0;
      override start(): void {
        this.starts += 1;
        this.started = true;
      }
    };
    const h = harness();
    await webSpeechStt().start(h.options);
    const rec = FakeRecognition.instances[0] as (FakeRecognition & { starts: number }) | undefined;
    rec?.onerror?.({ error: "network" });
    rec?.onend?.();
    expect(h.errors.map((e) => e.message)).toEqual(["Speech recognition error: network"]);
    expect(rec?.starts).toBe(1);
  });

  it("throws when the API is missing or the signal is already aborted", async () => {
    const h = harness();
    await expect(webSpeechStt().start(h.options)).rejects.toThrow(/not available/);
    g.SpeechRecognition = FakeRecognition;
    h.controller.abort();
    await expect(webSpeechStt().start(h.options)).rejects.toThrow(/cancelled/);
  });
});
