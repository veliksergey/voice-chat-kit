import type { SttProvider, SttSession, SttStartOptions } from "@voice-chat-kit/core";

export interface DeepgramSttOptions {
  /** Deepgram model; `nova-3` by default. */
  model?: string;
  /** BCP-47 tag (overridden by `start({ language })`); Deepgram's default is `en`. */
  language?: string;
  /** Punctuation, casing, and number formatting; on by default. */
  smartFormat?: boolean;
  /** How often MediaRecorder hands over an audio chunk. */
  timesliceMs?: number;
  /** Preferred MediaRecorder MIME type; the first supported of the defaults otherwise. */
  mimeType?: string;
  /** Streaming endpoint (tests override it). */
  endpoint?: string;
  /** How long to wait for Deepgram's final results after CloseStream. */
  closeTimeoutMs?: number;
}

const DEFAULT_ENDPOINT = "wss://api.deepgram.com/v1/listen";
// Containerized formats: Deepgram detects them, so no encoding/sample_rate parameters.
const MIME_CANDIDATES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];
const WS_OPEN = 1;
const WS_CLOSING = 2;

interface DeepgramResults {
  type: "Results";
  is_final?: boolean;
  speech_final?: boolean;
  channel?: { alternatives?: Array<{ transcript?: string }> };
}
interface DeepgramError {
  type: "Error";
  description?: string;
  message?: string;
  code?: string;
}
type DeepgramMessage = DeepgramResults | DeepgramError | { type: string };

// Browser globals are read at call time so tests can substitute them.
function browser(): {
  WebSocket: typeof WebSocket;
  MediaRecorder: typeof MediaRecorder;
  getUserMedia: (constraints: MediaStreamConstraints) => Promise<MediaStream>;
} {
  const g = globalThis as typeof globalThis & { MediaRecorder?: typeof MediaRecorder };
  if (typeof g.WebSocket !== "function") throw new Error("WebSocket is not available");
  if (typeof g.MediaRecorder !== "function") throw new Error("MediaRecorder is not available");
  const devices = g.navigator?.mediaDevices;
  if (!devices || typeof devices.getUserMedia !== "function") {
    throw new Error("Microphone access (getUserMedia) is not available");
  }
  return {
    WebSocket: g.WebSocket,
    MediaRecorder: g.MediaRecorder,
    getUserMedia: (c) => devices.getUserMedia(c),
  };
}

function pickMimeType(Recorder: typeof MediaRecorder, preferred?: string): string | undefined {
  const supported = (type: string): boolean =>
    typeof Recorder.isTypeSupported === "function" ? Recorder.isTypeSupported(type) : true;
  if (preferred) return supported(preferred) ? preferred : undefined;
  return MIME_CANDIDATES.find(supported);
}

const cancelledError = (): Error => new Error("Listening was cancelled");
const asError = (error: unknown, fallback: string): Error =>
  error instanceof Error ? error : new Error(fallback);

/**
 * Speech-to-text via Deepgram's streaming WebSocket, straight from the browser. The server
 * mints a short-lived token (`getToken`); the vendor API key never reaches the client. Audio is
 * MediaRecorder output sent as binary frames; Deepgram detects the container.
 *
 * Lifecycle: every failure, abort, or stop goes through one idempotent `teardown()` that stops
 * the recorder, releases the microphone, and closes the socket (also while still connecting).
 * An aborted signal is a cancellation (silent); a graceful `stop()` still reports errors that
 * occur while the final results are awaited, by rejecting. Any socket close before `stop()` —
 * clean or not — is a failure, because audio would otherwise be discarded silently.
 */
export function deepgramStt(options: DeepgramSttOptions = {}): SttProvider {
  const model = options.model ?? "nova-3";
  const smartFormat = options.smartFormat ?? true;
  const timesliceMs = options.timesliceMs ?? 250;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const closeTimeoutMs = options.closeTimeoutMs ?? 2000;

  return {
    id: "deepgram",
    capabilities: { streaming: true, interimResults: true, runsInBrowser: true, needsToken: true },
    isSupported: () => {
      try {
        browser();
        return true;
      } catch {
        return false;
      }
    },

    async start(start: SttStartOptions): Promise<SttSession> {
      if (!start.getToken) throw new Error("Deepgram requires a token source (getToken)");
      if (start.signal.aborted) throw cancelledError();
      const env = browser();

      // Microphone first: a denied permission should fail before a token is spent.
      const mediaStream = await env.getUserMedia({ audio: true });

      let socket: WebSocket | null = null;
      let recorder: MediaRecorder | null = null;
      let tornDown = false;
      let cancelled = false; // the caller's signal was aborted
      let finishing = false; // a graceful stop() is in progress
      let finalizeError: Error | null = null;
      let closed = false;
      let resolveClosed: (() => void) | null = null;
      const closed$ = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const finals: string[] = [];
      let interim = "";

      const teardown = (): void => {
        if (tornDown) return;
        tornDown = true;
        if (recorder && recorder.state !== "inactive") {
          try {
            recorder.stop();
          } catch {
            // already stopping
          }
        }
        for (const track of mediaStream.getTracks()) track.stop();
        // close() also cancels a connection attempt that is still in progress.
        if (socket && socket.readyState < WS_CLOSING) socket.close(1000, "done");
      };

      const fail = (error: Error): void => {
        if (cancelled) {
          teardown();
          return;
        }
        if (finishing) {
          // stop() is awaiting the final results; it rejects with the first failure.
          finalizeError ??= error;
          teardown();
          resolveClosed?.();
          return;
        }
        teardown();
        start.onError(error);
      };

      const onAbort = (): void => {
        cancelled = true;
        teardown();
        resolveClosed?.();
      };
      start.signal.addEventListener("abort", onAbort, { once: true });
      if (start.signal.aborted) {
        onAbort();
        throw cancelledError();
      }

      let token: string;
      try {
        token = (await start.getToken(start.signal)).token;
      } catch (error) {
        teardown();
        throw error;
      }
      if (cancelled) throw cancelledError();

      // URL and socket construction can throw (bad endpoint, token invalid as a subprotocol);
      // the microphone is already live, so these are inside the exception-safe region too.
      let ws: WebSocket;
      try {
        const url = new URL(endpoint);
        url.searchParams.set("model", model);
        const language = start.language ?? options.language;
        if (language) url.searchParams.set("language", language);
        url.searchParams.set("interim_results", "true");
        if (smartFormat) url.searchParams.set("smart_format", "true");
        // The token travels only in the WebSocket subprotocol, never in the URL.
        ws = new env.WebSocket(url.toString(), ["bearer", token]);
      } catch (error) {
        teardown();
        throw asError(error, "Could not open the Deepgram connection");
      }
      socket = ws;

      await new Promise<void>((resolve, reject) => {
        ws.onopen = () => resolve();
        // An abort tears the socket down, which fires close/error: report that as a cancellation.
        const failEarly = (): void =>
          reject(cancelled ? cancelledError() : new Error("Could not connect to Deepgram"));
        ws.addEventListener("error", failEarly, { once: true });
        ws.addEventListener("close", failEarly, { once: true });
        start.signal.addEventListener("abort", () => reject(cancelledError()), { once: true });
      }).catch((error: unknown) => {
        teardown();
        throw error;
      });
      if (cancelled) throw cancelledError();

      // Handlers for the live session are attached only once the socket is open, so handshake
      // failures are reported exactly once (by the rejection above).
      ws.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== "string") return;
        let message: DeepgramMessage;
        try {
          message = JSON.parse(event.data) as DeepgramMessage;
        } catch {
          return;
        }
        if (message.type === "Results") {
          const results = message as DeepgramResults;
          const transcript = (results.channel?.alternatives?.[0]?.transcript ?? "").trim();
          if (results.is_final) {
            interim = "";
            if (transcript) {
              finals.push(transcript);
              start.onFinal(transcript);
            }
            start.onPartial("");
          } else {
            interim = transcript;
            start.onPartial(transcript);
          }
        } else if (message.type === "Error") {
          const error = message as DeepgramError;
          fail(
            new Error(
              `Deepgram error: ${error.description ?? error.message ?? error.code ?? "unknown"}`,
            ),
          );
        }
      };
      ws.onerror = () => fail(new Error("Deepgram connection error"));
      ws.onclose = (event: CloseEvent) => {
        closed = true;
        resolveClosed?.();
        if (tornDown || cancelled) return;
        // Only the clean close that answers our CloseStream is expected; anything else ends the
        // session early and would otherwise discard audio silently.
        if (finishing && event.code === 1000) return;
        fail(new Error(`Deepgram connection closed (${event.code})`));
      };

      try {
        const mimeType = pickMimeType(env.MediaRecorder, options.mimeType);
        const rec = new env.MediaRecorder(mediaStream, mimeType ? { mimeType } : {});
        rec.ondataavailable = (event: BlobEvent) => {
          if (event.data.size > 0 && ws.readyState === WS_OPEN) ws.send(event.data);
        };
        // Recording can fail asynchronously (device lost, encoder error); that ends the session.
        rec.onerror = () => fail(new Error("Recording failed"));
        rec.start(timesliceMs);
        recorder = rec;
      } catch (error) {
        teardown();
        throw asError(error, "Could not start recording");
      }

      const recorderStopped = (): Promise<void> =>
        new Promise((resolve) => {
          if (!recorder || recorder.state === "inactive") {
            resolve();
            return;
          }
          recorder.onstop = () => resolve();
          recorder.stop();
        });

      return {
        async stop(): Promise<string> {
          if (cancelled) return "";
          finishing = true;
          // The last chunk is delivered before `onstop`; then ask Deepgram to flush its finals.
          await recorderStopped();
          if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ type: "CloseStream" }));
          if (!closed && !tornDown) {
            await Promise.race([closed$, new Promise<void>((r) => setTimeout(r, closeTimeoutMs))]);
          }
          teardown();
          if (finalizeError) throw finalizeError;
          const trailing = interim.trim();
          return [...finals, ...(trailing ? [trailing] : [])].join(" ");
        },
      };
    },
  };
}
