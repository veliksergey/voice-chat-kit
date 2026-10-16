import type { TtsProvider, TtsSpeakOptions } from "@voice-chat-kit/core";

export interface DeepgramTtsOptions {
  /** Aura voice (model id), e.g. `aura-2-thalia-en`; overridden by `speak({ voice })`. */
  model?: string;
  /** Output sample rate for linear16 PCM; Deepgram supports 8000–48000. */
  sampleRate?: 8000 | 16000 | 24000 | 32000 | 48000;
  /** Streaming endpoint (tests override it). */
  endpoint?: string;
  /** After `Close`, how long Deepgram may take to finish sending audio before speech fails. */
  closeTimeoutMs?: number;
}

const DEFAULT_ENDPOINT = "wss://api.deepgram.com/v1/speak";
const DEFAULT_MODEL = "aura-2-thalia-en";
const WS_OPEN = 1;
const WS_CLOSING = 2;
// Lead used only for the first buffer or after an underrun, so nothing is scheduled in the
// past; while audio is queued ahead of the clock, buffers chain back-to-back.
const SCHEDULE_LEAD_S = 0.02;
// Deepgram's documented cap for one text payload (Aura-1/Aura-2, checked 2026-10-16).
const MAX_SPEAK_CHARS = 2000;
// Deepgram accepts at most 20 Flush messages per 60 s (flush page, checked 2026-10-16); a
// sliding window at that rate satisfies either a fixed or a rolling server-side window.
const FLUSH_LIMIT = 20;
const FLUSH_WINDOW_MS = 60_000;
// Deepgram's text throughput cap, "measured by the number of characters sent to the websocket"
// (streaming TTS page, checked 2026-10-16). Speech plays back slower than this, so pacing the
// text never starves playback.
const CHAR_LIMIT = 2400;
const CHAR_WINDOW_MS = 60_000;

interface DeepgramControl {
  type: string;
  sequence_id?: number;
  description?: string;
  code?: string;
  message?: string;
}

interface AudioEnv {
  WebSocket: typeof WebSocket;
  AudioContext: typeof AudioContext;
}

function browser(): AudioEnv {
  const g = globalThis as typeof globalThis & { webkitAudioContext?: typeof AudioContext };
  if (typeof g.WebSocket !== "function") throw new Error("WebSocket is not available");
  const Ctx = g.AudioContext ?? g.webkitAudioContext;
  if (typeof Ctx !== "function") throw new Error("Web Audio (AudioContext) is not available");
  return { WebSocket: g.WebSocket, AudioContext: Ctx };
}

/** PCM16 little-endian bytes to the float samples Web Audio expects. */
export function pcm16ToFloat32(bytes: ArrayBuffer): Float32Array {
  const usable = bytes.byteLength - (bytes.byteLength % 2);
  const view = new DataView(bytes, 0, usable);
  const out = new Float32Array(usable / 2);
  for (let i = 0; i < out.length; i++) out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}

/**
 * Splits text into `Speak`-sized payloads whose concatenation is the original text: after the
 * last space inside the cap (the separator stays with the preceding part, since Deepgram appends
 * payloads to one buffer), or hard when there is none (never between the halves of a surrogate
 * pair).
 */
export function splitForSpeak(text: string, max: number = MAX_SPEAK_CHARS): string[] {
  const parts: string[] = [];
  let rest = text;
  while (rest.length > max) {
    let cut = rest.lastIndexOf(" ", max - 1) + 1;
    if (cut <= 1) {
      cut = max;
      const code = rest.charCodeAt(cut - 1);
      if (code >= 0xd800 && code <= 0xdbff) cut -= 1;
    }
    parts.push(rest.slice(0, cut));
    rest = rest.slice(cut);
  }
  if (rest) parts.push(rest);
  return parts.filter((part) => part.length > 0);
}

const STOP: IteratorReturnResult<undefined> = { done: true, value: undefined };

/**
 * Text-to-speech via Deepgram Aura over its streaming WebSocket, straight from the browser with
 * a server-minted token (`getToken`) presented as the `["bearer", <jwt>]` subprotocol. Each
 * sentence is sent as `Speak` (split into payloads of at most 2,000 characters) + `Flush`, with
 * flushes paced to Deepgram's limit of 20 per 60 s (past the budget, text keeps streaming and
 * one deferred `Flush`, or `Close`, covers it) and text paced to its 2,400 characters per minute
 * (a part that would overflow waits, abortably, for the window); raw linear16 PCM frames come back (the streaming endpoint emits raw audio only) and are scheduled
 * gaplessly on an `AudioContext` created synchronously at `speak()`, inside the user's gesture,
 * before any network wait. `Close` ends the stream once the reply is complete; completion is
 * Deepgram closing the socket after every `Flush` was acknowledged by a `Flushed` and the last
 * buffer ended. A clean close with flushes unacknowledged, or no close within `closeTimeoutMs`,
 * is a failure. Abort stops playback and tears everything down.
 */
export function deepgramTts(options: DeepgramTtsOptions = {}): TtsProvider {
  const sampleRate = options.sampleRate ?? 24000;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const closeTimeoutMs = options.closeTimeoutMs ?? 10_000;

  return {
    id: "deepgram",
    capabilities: { streamingInput: true, runsInBrowser: true, needsToken: true },
    isSupported: () => {
      try {
        browser();
        return true;
      } catch {
        return false;
      }
    },

    async speak(sentences: AsyncIterable<string>, speak: TtsSpeakOptions): Promise<void> {
      if (!speak.getToken) throw new Error("Deepgram requires a token source (getToken)");
      if (speak.signal.aborted) return;
      const env = browser();
      const model = speak.voice ?? options.model ?? DEFAULT_MODEL;

      let cancelled = false;
      let tornDown = false;
      let socket: WebSocket | null = null;
      let context: AudioContext | null = null;
      const sources = new Set<AudioBufferSourceNode>();
      let nextStartTime = 0;
      let started = false;
      let textEnded = false;
      let socketClosed = false;
      // One `Flush` per sentence; completion needs each acknowledged by a `Flushed`.
      let flushesSent = 0;
      let flushesAcked = 0;
      let flushedSeen = 0;
      // Send times of the flushes inside the current window, plus the deferred flush, if any.
      const flushTimes: number[] = [];
      let flushTimer: ReturnType<typeof setTimeout> | null = null;
      let flushPending = false;
      // Characters sent inside the current throughput window, oldest first.
      const charEvents: Array<{ at: number; count: number }> = [];
      let failure: Error | null = null;
      let settle: (() => void) | null = null;
      // Resolves when speech is over for any reason: finished, failed, or cancelled.
      const settled$ = new Promise<void>((resolve) => {
        settle = resolve;
      });

      const teardown = (): void => {
        if (tornDown) return;
        tornDown = true;
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        for (const source of sources) {
          try {
            source.stop();
          } catch {
            // not started or already ended
          }
        }
        sources.clear();
        if (socket && socket.readyState < WS_CLOSING) socket.close(1000, "done");
        void context?.close().catch(() => undefined);
      };
      const fail = (error: Error): void => {
        if (cancelled || failure) return;
        failure = error;
        teardown();
        settle?.();
      };
      // Finished when the reply text is done, Deepgram has closed (all audio sent), and every
      // scheduled buffer has ended.
      const maybeSettle = (): void => {
        if (textEnded && socketClosed && flushesAcked >= flushesSent && sources.size === 0) {
          settle?.();
        }
      };

      const onAbort = (): void => {
        cancelled = true;
        teardown();
        settle?.();
      };
      speak.signal.addEventListener("abort", onAbort, { once: true });

      try {
        // Created before any await so it is still inside the caller's gesture; a context created
        // later may be left suspended by autoplay policy. Resume covers browsers that suspend anyway.
        const ctx = new env.AudioContext({ sampleRate });
        context = ctx;
        if (ctx.state === "suspended") void ctx.resume().catch(() => undefined);

        // A stalled token request must not outlive Stop: race it against abort.
        const token = await Promise.race([
          speak.getToken(speak.signal).then((info) => info.token),
          settled$.then(() => null),
        ]);
        if (cancelled || token === null) return;

        const url = new URL(endpoint);
        url.searchParams.set("model", model);
        url.searchParams.set("encoding", "linear16");
        url.searchParams.set("sample_rate", String(sampleRate));
        // The token travels only in the WebSocket subprotocol, never in the URL.
        const ws = new env.WebSocket(url.toString(), ["bearer", token]);
        ws.binaryType = "arraybuffer";
        socket = ws;

        await new Promise<void>((resolve, reject) => {
          ws.onopen = () => resolve();
          const failEarly = (): void =>
            reject(
              cancelled
                ? new Error("Speech was cancelled")
                : new Error("Could not connect to Deepgram text-to-speech"),
            );
          ws.addEventListener("error", failEarly, { once: true });
          ws.addEventListener("close", failEarly, { once: true });
          speak.signal.addEventListener("abort", () => reject(new Error("Speech was cancelled")), {
            once: true,
          });
        });
        if (cancelled) return;

        ws.onmessage = (event: MessageEvent) => {
          if (event.data instanceof ArrayBuffer) {
            const samples = pcm16ToFloat32(event.data);
            if (samples.length === 0) return;
            const buffer = ctx.createBuffer(1, samples.length, sampleRate);
            buffer.getChannelData(0).set(samples);
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            const now = ctx.currentTime;
            const startAt = nextStartTime > now ? nextStartTime : now + SCHEDULE_LEAD_S;
            nextStartTime = startAt + buffer.duration;
            sources.add(source);
            source.onended = () => {
              sources.delete(source);
              maybeSettle();
            };
            source.start(startAt);
            if (!started) {
              started = true;
              speak.onStart?.();
            }
            return;
          }
          if (typeof event.data !== "string") return;
          let control: DeepgramControl;
          try {
            control = JSON.parse(event.data) as DeepgramControl;
          } catch {
            return;
          }
          if (control.type === "Flushed") {
            // The docs do not define `sequence_id`; count messages and trust a numeric id when
            // present (0-based per flush is the documented example), whichever is further.
            flushedSeen += 1;
            const bySequence =
              typeof control.sequence_id === "number" ? control.sequence_id + 1 : 0;
            flushesAcked = Math.max(flushesAcked, flushedSeen, bySequence);
            maybeSettle();
            return;
          }
          if (control.type === "Error") {
            fail(
              new Error(
                `Deepgram text-to-speech error: ${control.description ?? control.message ?? control.code ?? "unknown"}`,
              ),
            );
          }
          // Metadata, Cleared, Warning: informational for this adapter.
        };
        ws.onerror = () => fail(new Error("Deepgram text-to-speech connection error"));
        ws.onclose = (event: CloseEvent) => {
          socketClosed = true;
          if (tornDown || cancelled) return;
          if (!textEnded || event.code !== 1000) {
            fail(new Error(`Deepgram text-to-speech connection closed (${event.code})`));
            return;
          }
          if (flushesAcked < flushesSent) {
            // A clean close only means completion once every flush was acknowledged; otherwise
            // speech was lost on the way and must not pass as a spoken reply.
            fail(
              new Error(
                `Deepgram text-to-speech closed before all speech was confirmed (${flushesAcked} of ${flushesSent} flushes acknowledged)`,
              ),
            );
            return;
          }
          maybeSettle();
        };

        // Within the budget every sentence gets its own Flush; past it, the text still goes out
        // and one Flush is deferred until the oldest flush leaves the window.
        const sendFlush = (): void => {
          const now = Date.now();
          while (flushTimes.length > 0 && now - (flushTimes[0] ?? now) >= FLUSH_WINDOW_MS) {
            flushTimes.shift();
          }
          const oldest = flushTimes[0];
          if (oldest !== undefined && flushTimes.length >= FLUSH_LIMIT) {
            flushPending = true;
            flushTimer ??= setTimeout(
              () => {
                flushTimer = null;
                if (flushPending && !tornDown && ws.readyState === WS_OPEN) sendFlush();
              },
              FLUSH_WINDOW_MS - (now - oldest) + 50,
            );
            return;
          }
          flushPending = false;
          flushTimes.push(now);
          ws.send(JSON.stringify({ type: "Flush" }));
          flushesSent += 1;
        };

        // Deepgram meters characters per minute. A part that would overflow the window waits,
        // abortably, until enough of the oldest characters have aged out.
        const waitUntil = (at: number): Promise<void> =>
          new Promise<void>((resolve) => {
            const timer = setTimeout(resolve, Math.max(0, at - Date.now()));
            void settled$.then(() => {
              clearTimeout(timer);
              resolve();
            });
          });
        const reserveCharacters = async (count: number): Promise<void> => {
          for (;;) {
            const now = Date.now();
            while (charEvents.length > 0 && now - (charEvents[0]?.at ?? now) >= CHAR_WINDOW_MS) {
              charEvents.shift();
            }
            const used = charEvents.reduce((sum, event) => sum + event.count, 0);
            const oldest = charEvents[0];
            if (oldest === undefined || used + count <= CHAR_LIMIT) {
              charEvents.push({ at: now, count });
              return;
            }
            await waitUntil(oldest.at + CHAR_WINDOW_MS + 50);
            if (cancelled || failure) return;
          }
        };

        // Waiting for the next sentence races against failure/abort: a stalled reply must not
        // keep a dead session alive.
        const iterator = sentences[Symbol.asyncIterator]();
        const stop$ = settled$.then(() => STOP);
        try {
          for (;;) {
            const result = await Promise.race([iterator.next(), stop$]);
            if (result.done) break;
            const text = result.value.trim();
            if (!text) continue;
            if (ws.readyState !== WS_OPEN) break;
            // While a Flush is deferred, Deepgram's buffer still holds the previous sentence, so
            // the next one starts with a space; the cap leaves one character of room for it.
            const parts = splitForSpeak(text, MAX_SPEAK_CHARS - 1);
            for (const [index, part] of parts.entries()) {
              await reserveCharacters(part.length + 1);
              if (cancelled || failure || ws.readyState !== WS_OPEN) break;
              const payload = index === 0 && flushPending ? ` ${part}` : part;
              ws.send(JSON.stringify({ type: "Speak", text: payload }));
            }
            if (cancelled || failure || ws.readyState !== WS_OPEN) break;
            sendFlush();
          }
        } finally {
          // Not awaited: a producer suspended mid-await queues return() behind its pending
          // next(), so waiting here could hang; signalling it is all we can do.
          if (cancelled || failure) void iterator.return?.().catch(() => undefined);
        }
        textEnded = true;
        // `Close` flushes whatever text is still buffered, so a deferred flush is moot now.
        if (flushTimer !== null) {
          clearTimeout(flushTimer);
          flushTimer = null;
        }
        flushPending = false;
        if (!cancelled && !failure) {
          if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: "Close" }));
          // Deepgram closes the socket once all audio is generated. Not hearing that in time is
          // a failure: declaring success would hide audio that never arrived.
          const timeout = setTimeout(() => {
            if (!socketClosed) {
              fail(new Error(`Deepgram text-to-speech did not finish within ${closeTimeoutMs} ms`));
            }
          }, closeTimeoutMs);
          maybeSettle();
          await settled$;
          clearTimeout(timeout);
        }
        if (failure) throw failure;
        if (!cancelled) {
          teardown();
          speak.onEnd?.();
        }
      } catch (error) {
        teardown();
        if (cancelled) return;
        throw error;
      } finally {
        speak.signal.removeEventListener("abort", onAbort);
      }
    },
  };
}
