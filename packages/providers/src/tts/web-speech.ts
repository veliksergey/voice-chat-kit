import type { TtsProvider, TtsSpeakOptions } from "@voice-chat-kit/core";

export interface WebSpeechTtsOptions {
  /** Voice name or `voiceURI` to prefer (overridden by `speak({ voice })`); browser default otherwise. */
  voice?: string;
  language?: string;
  rate?: number;
  pitch?: number;
}

// Structural types so the adapter does not depend on lib.dom's SpeechSynthesis typings.
interface VoiceLike {
  readonly name: string;
  readonly voiceURI: string;
}
interface UtteranceLike {
  text: string;
  lang: string;
  rate: number;
  pitch: number;
  voice: VoiceLike | null;
  onstart: (() => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
}
interface SynthesisLike {
  speak(utterance: UtteranceLike): void;
  cancel(): void;
  getVoices(): VoiceLike[];
}
type UtteranceCtor = new (text: string) => UtteranceLike;

function synthesis(): { synth: SynthesisLike; Utterance: UtteranceCtor } | undefined {
  const g = globalThis as Record<string, unknown>;
  const synth = g.speechSynthesis as SynthesisLike | undefined;
  const Utterance = g.SpeechSynthesisUtterance as UtteranceCtor | undefined;
  if (!synth || typeof synth.speak !== "function" || typeof Utterance !== "function") {
    return undefined;
  }
  return { synth, Utterance };
}

// Errors the browser reports when *we* cancelled; not failures.
const CANCEL_ERRORS: ReadonlySet<string> = new Set(["interrupted", "canceled"]);
const STOP: IteratorReturnResult<undefined> = { done: true, value: undefined };

/**
 * Text-to-speech via the browser's `speechSynthesis`. Free and offline-capable (OS voices);
 * sentences are queued as they arrive and spoken in order. The browser owns playback, so there
 * is no audio buffer to inspect; abort maps to `speechSynthesis.cancel()`. Chromium's cancel()
 * drops unstarted utterances without firing any event for them, so on abort completion is
 * settled here instead of awaited from the browser.
 */
export function webSpeechTts(options: WebSpeechTtsOptions = {}): TtsProvider {
  return {
    id: "web-speech",
    capabilities: { streamingInput: true, runsInBrowser: true, needsToken: false },
    isSupported: () => synthesis() !== undefined,

    async speak(sentences: AsyncIterable<string>, speak: TtsSpeakOptions): Promise<void> {
      const env = synthesis();
      if (!env) throw new Error("Speech synthesis is not available in this browser");
      if (speak.signal.aborted) return;

      const voiceName = speak.voice ?? options.voice;
      const voice = voiceName
        ? (env.synth.getVoices().find((v) => v.name === voiceName || v.voiceURI === voiceName) ??
          null)
        : null;

      let cancelled = false;
      let started = false;
      let failure: Error | null = null;
      const pending: Promise<void>[] = [];
      // Each utterance's completion resolver, so abort can settle them all at once.
      const waiters: Array<() => void> = [];
      let unblock: (() => void) | null = null;
      // Resolves on abort or on the first real error so a stalled sentence feed cannot hang us.
      const stop$ = new Promise<void>((resolve) => {
        unblock = resolve;
      }).then(() => STOP);
      const onAbort = (): void => {
        cancelled = true;
        env.synth.cancel();
        for (const resolve of waiters.splice(0)) resolve();
        unblock?.();
      };
      speak.signal.addEventListener("abort", onAbort, { once: true });

      const iterator = sentences[Symbol.asyncIterator]();
      try {
        for (;;) {
          const result = await Promise.race([iterator.next(), stop$]);
          if (result.done || cancelled || failure) break;
          const text = result.value.trim();
          if (!text) continue;
          const utterance = new env.Utterance(text);
          if (options.language) utterance.lang = options.language;
          if (options.rate !== undefined) utterance.rate = options.rate;
          if (options.pitch !== undefined) utterance.pitch = options.pitch;
          if (voice) utterance.voice = voice;
          pending.push(
            new Promise<void>((resolve, reject) => {
              waiters.push(resolve);
              utterance.onstart = () => {
                if (!started) {
                  started = true;
                  speak.onStart?.();
                }
              };
              utterance.onend = () => resolve();
              utterance.onerror = (event) => {
                if (cancelled || CANCEL_ERRORS.has(event.error)) {
                  resolve();
                  return;
                }
                const error = new Error(`Speech synthesis error: ${event.error}`);
                failure ??= error;
                unblock?.();
                reject(error);
              };
            }),
          );
          env.synth.speak(utterance);
        }
        // Not awaited: a producer suspended mid-await would queue return() behind its next().
        if (cancelled || failure) void iterator.return?.().catch(() => undefined);
        await Promise.all(pending);
        if (failure) throw failure;
        if (!cancelled) speak.onEnd?.();
      } catch (error) {
        if (!cancelled) {
          env.synth.cancel();
          throw error;
        }
      } finally {
        speak.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
