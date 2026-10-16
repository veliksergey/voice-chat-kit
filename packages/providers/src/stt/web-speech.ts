import type { SttProvider, SttSession, SttStartOptions } from "@voice-chat-kit/core";

export interface WebSpeechSttOptions {
  /** BCP-47 tag; the browser default when omitted (overridden by `start({ language })`). */
  language?: string;
}

// Minimal structural types so the adapter does not depend on lib.dom's SpeechRecognition typings.
interface RecognitionResultLike {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: { readonly transcript: string } | undefined;
}
interface RecognitionEventLike {
  readonly resultIndex: number;
  readonly results: { readonly length: number; [index: number]: RecognitionResultLike | undefined };
}
interface RecognitionErrorEventLike {
  readonly error: string;
  readonly message?: string;
}
interface RecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((event: RecognitionEventLike) => void) | null;
  onerror: ((event: RecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}
type RecognitionCtor = new () => RecognitionLike;

function recognitionCtor(): RecognitionCtor | undefined {
  const g = globalThis as Record<string, unknown>;
  const ctor = g.SpeechRecognition ?? g.webkitSpeechRecognition;
  return typeof ctor === "function" ? (ctor as RecognitionCtor) : undefined;
}

// Errors that are not failures: the user stopped, or simply did not speak.
const BENIGN_ERRORS: ReadonlySet<string> = new Set(["aborted", "no-speech"]);

/**
 * Speech-to-text via the browser's Web Speech API. Free and zero-setup, but Chrome sends the
 * audio to Google's servers and Firefox ships it disabled; check `isSupported()` first.
 *
 * Browsers end recognition on their own (silence timeouts, service hiccups); while the session
 * is neither stopping nor cancelled nor failed, recognition is restarted so a held push-to-talk
 * keeps capturing. Finals are accumulated across restarts.
 */
export function webSpeechStt(options: WebSpeechSttOptions = {}): SttProvider {
  return {
    id: "web-speech",
    capabilities: { streaming: true, interimResults: true, runsInBrowser: true, needsToken: false },
    isSupported: () => recognitionCtor() !== undefined,

    async start(start: SttStartOptions): Promise<SttSession> {
      const Ctor = recognitionCtor();
      if (!Ctor) throw new Error("Web Speech API is not available in this browser");
      if (start.signal.aborted) throw new Error("Listening was cancelled");

      const recognition = new Ctor();
      const language = start.language ?? options.language;
      if (language) recognition.lang = language;
      recognition.continuous = true;
      recognition.interimResults = true;

      const finals: string[] = [];
      let finalized = new Set<number>();
      let interim = "";
      let running = false;
      let cancelled = false; // the caller's signal was aborted: stay silent
      let finishing = false; // graceful stop(): errors are still real and reject stop()
      let failed = false; // a real error was reported; do not restart
      let finalizeError: Error | null = null;
      let endWaiters: Array<() => void> = [];

      const waitForEnd = (): Promise<void> =>
        new Promise((resolve) => {
          endWaiters.push(resolve);
        });

      // `results` is cumulative within one recognition run; finals are reported once by index
      // and the interim text is whatever is not final yet.
      recognition.onresult = (event) => {
        let pending = "";
        for (let i = 0; i < event.results.length; i++) {
          const result = event.results[i];
          if (!result) continue;
          const transcript = result[0]?.transcript ?? "";
          if (result.isFinal) {
            if (finalized.has(i)) continue;
            finalized.add(i);
            const text = transcript.trim();
            if (text) {
              finals.push(text);
              start.onFinal(text);
            }
          } else {
            pending += transcript;
          }
        }
        interim = pending.trim();
        start.onPartial(interim);
      };
      recognition.onerror = (event) => {
        if (BENIGN_ERRORS.has(event.error) || cancelled) return;
        const error = new Error(`Speech recognition error: ${event.error}`);
        failed = true;
        if (finishing) {
          finalizeError ??= error;
          return;
        }
        start.onError(error);
      };
      recognition.onend = () => {
        running = false;
        const waiters = endWaiters;
        endWaiters = [];
        for (const resolve of waiters) resolve();
        if (finishing || cancelled || failed) return;
        // Ended on its own while still held: keep listening. Each run reports results from
        // index 0 again, so the per-run finalisation set starts over; `finals` accumulates.
        try {
          finalized = new Set<number>();
          interim = "";
          recognition.start();
          running = true;
        } catch {
          failed = true;
          start.onError(new Error("Speech recognition stopped unexpectedly"));
        }
      };
      start.signal.addEventListener("abort", () => {
        cancelled = true;
        if (running) recognition.abort();
      });

      recognition.start();
      running = true;

      return {
        async stop(): Promise<string> {
          if (cancelled) return "";
          finishing = true;
          if (running) {
            const ended = waitForEnd();
            recognition.stop();
            // Browsers fire `onend` shortly after stop(); never hang if one does not.
            await Promise.race([ended, new Promise<void>((r) => setTimeout(r, 1500))]);
          }
          if (finalizeError) throw finalizeError;
          const trailing = interim.trim();
          return [...finals, ...(trailing ? [trailing] : [])].join(" ");
        },
      };
    },
  };
}
