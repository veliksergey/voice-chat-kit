// @vitest-environment jsdom
import { afterEach, describe, expect, it } from "vitest";
import { webSpeechTts } from "./web-speech.js";

class FakeUtterance {
  static instances: FakeUtterance[] = [];
  lang = "";
  rate = 1;
  pitch = 1;
  voice: { name: string; voiceURI: string } | null = null;
  onstart: (() => void) | null = null;
  onend: (() => void) | null = null;
  onerror: ((event: { error: string }) => void) | null = null;
  constructor(public text: string) {
    FakeUtterance.instances.push(this);
  }
}

/**
 * Chromium-shaped speechSynthesis: `cancel()` reports `interrupted` only for the utterance that
 * is currently speaking and silently discards the ones that have not started yet.
 */
class FakeSynthesis {
  queue: FakeUtterance[] = [];
  current: FakeUtterance | null = null;
  cancelCalls = 0;
  voices: Array<{ name: string; voiceURI: string }> = [
    { name: "Samantha", voiceURI: "urn:samantha" },
    { name: "Daniel", voiceURI: "urn:daniel" },
  ];
  speak(utterance: FakeUtterance): void {
    this.queue.push(utterance);
  }
  cancel(): void {
    this.cancelCalls += 1;
    const speaking = this.current;
    this.current = null;
    this.queue.length = 0;
    speaking?.onerror?.({ error: "interrupted" });
  }
  getVoices() {
    return this.voices;
  }
  /** Begins the next queued utterance. */
  startNext(): FakeUtterance | undefined {
    const u = this.queue.shift();
    if (u) {
      this.current = u;
      u.onstart?.();
    }
    return u;
  }
  /** Ends the utterance that is speaking. */
  endCurrent(): void {
    const u = this.current;
    this.current = null;
    u?.onend?.();
  }
  /** Plays the next queued utterance to completion. */
  playNext(): void {
    this.startNext();
    this.endCurrent();
  }
}

const g = globalThis as Record<string, unknown>;
let synth: FakeSynthesis;

function install(): void {
  synth = new FakeSynthesis();
  g.speechSynthesis = synth;
  g.SpeechSynthesisUtterance = FakeUtterance;
}

afterEach(() => {
  g.speechSynthesis = undefined;
  g.SpeechSynthesisUtterance = undefined;
  FakeUtterance.instances = [];
});

async function* sentences(list: string[]): AsyncGenerator<string> {
  for (const s of list) yield s;
}

describe("webSpeechTts", () => {
  it("queues one utterance per sentence in order and resolves after the last one ends", async () => {
    install();
    const events: string[] = [];
    const controller = new AbortController();
    const speaking = webSpeechTts({ language: "en-US", rate: 1.1 }).speak(
      sentences(["Hello there.", "  ", "How are you?"]),
      {
        voice: "Daniel",
        signal: controller.signal,
        onStart: () => events.push("start"),
        onEnd: () => events.push("end"),
      },
    );
    await new Promise((r) => setTimeout(r, 0));
    expect(synth.queue.map((u) => u.text)).toEqual(["Hello there.", "How are you?"]);
    expect(synth.queue[0]).toMatchObject({ lang: "en-US", rate: 1.1 });
    expect(synth.queue[0]?.voice?.name).toBe("Daniel");

    synth.playNext();
    expect(events).toEqual(["start"]);
    synth.playNext();
    await speaking;
    expect(events).toEqual(["start", "end"]);
  });

  it("abort cancels synthesis and resolves although unstarted utterances get no events", async () => {
    install();
    const controller = new AbortController();
    let ended = false;
    const speaking = webSpeechTts().speak(sentences(["One.", "Two.", "Three."]), {
      signal: controller.signal,
      onEnd: () => {
        ended = true;
      },
    });
    await new Promise((r) => setTimeout(r, 0));
    expect(synth.queue).toHaveLength(3);
    synth.startNext(); // "One." is speaking; "Two." and "Three." never start
    controller.abort();
    await speaking; // would hang if completion waited for events from the dropped utterances
    expect(synth.cancelCalls).toBe(1);
    expect(synth.queue).toHaveLength(0);
    expect(ended).toBe(false);
  });

  it("abort before any utterance has started also resolves", async () => {
    install();
    const controller = new AbortController();
    const speaking = webSpeechTts().speak(sentences(["One.", "Two."]), {
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    controller.abort();
    await speaking;
    expect(synth.cancelCalls).toBe(1);
  });

  it("rejects on a real synthesis error and cancels the rest", async () => {
    install();
    const controller = new AbortController();
    const speaking = webSpeechTts().speak(sentences(["One.", "Two."]), {
      signal: controller.signal,
    });
    await new Promise((r) => setTimeout(r, 0));
    synth.startNext();
    synth.current?.onerror?.({ error: "synthesis-failed" });
    await expect(speaking).rejects.toThrow(/synthesis-failed/);
    expect(synth.cancelCalls).toBe(1);
  });

  it("reports support and refuses to start without the API or when already aborted", async () => {
    expect(webSpeechTts().isSupported?.()).toBe(false);
    await expect(
      webSpeechTts().speak(sentences(["x"]), { signal: new AbortController().signal }),
    ).rejects.toThrow(/not available/);
    install();
    expect(webSpeechTts().isSupported?.()).toBe(true);
    const aborted = new AbortController();
    aborted.abort();
    await webSpeechTts().speak(sentences(["x"]), { signal: aborted.signal });
    expect(synth.queue).toHaveLength(0);
    expect(webSpeechTts().capabilities).toEqual({
      streamingInput: true,
      runsInBrowser: true,
      needsToken: false,
    });
  });
});
