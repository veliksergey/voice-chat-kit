import {
  buildHistoryWindow,
  type ChatMessage,
  type ChatUsage,
  dropOldestTurns,
  type HistoryWindowOptions,
  parseChatEvent,
  parseSse,
  type RefusalInfo,
  type SessionState,
  type SttProvider,
  type SttSession,
  type SttStartOptions,
  type TokenInfo,
  type TtsProvider,
  transition,
  type WireMessage,
} from "@voice-chat-kit/core";
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseVoiceChatOptions {
  /** Prefix of the server routes, e.g. `/api`. */
  baseUrl: string;
  /** Speech-to-text provider for `startListening`/`stopListening`. */
  stt?: SttProvider;
  /** Reserved for Phase 3 (text-to-speech). */
  tts?: TtsProvider;
  /** BCP-47 language passed to the STT provider. */
  language?: string;
  fetch?: typeof globalThis.fetch;
  historyWindow?: Partial<HistoryWindowOptions>;
}

export interface FallbackInfo {
  from: string;
  to: string;
}

export interface UseVoiceChatResult {
  messages: ChatMessage[];
  /** Live transcript while listening; empty otherwise. */
  interimTranscript: string;
  state: SessionState;
  error: string | null;
  lastRefusal: RefusalInfo | null;
  lastFallback: FallbackInfo | null;
  usage: ChatUsage | null;
  /** Id of the configured STT provider, or null when voice input is unavailable. */
  sttProviderId: string | null;
  /** Sends typed text as a user turn and streams the reply. No-op while a turn is in flight. */
  sendText(text: string): Promise<void>;
  /** Push-to-talk press: starts the STT session (idle -> listening). */
  startListening(): Promise<void>;
  /** Push-to-talk release: finalises the transcript and sends it as the user turn. */
  stopListening(): Promise<void>;
  /** Aborts the in-flight turn or listening session; a partial reply stays, an empty one is dropped. */
  stop(): void;
  /** Leaves the error state. */
  reset(): void;
  /** Aborts any turn and clears the transcript, history, and notices. */
  newConversation(): void;
}

/**
 * One push-to-talk operation, registered before the provider's (possibly slow) startup so a
 * release, Stop, or unmount during startup is honoured. Results are accepted only while this
 * record is still the active one and not cancelled.
 */
interface Listening {
  controller: AbortController;
  session: SttSession | null;
  /** Release arrived while startup was still pending; finish as soon as it settles. */
  releaseRequested: boolean;
  cancelled: boolean;
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `m${Date.now().toString(36)}${counter}`;
}

export function useVoiceChat(options: UseVoiceChatOptions): UseVoiceChatResult {
  const { baseUrl, historyWindow, stt, language } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<SessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastRefusal, setLastRefusal] = useState<RefusalInfo | null>(null);
  const [lastFallback, setLastFallback] = useState<FallbackInfo | null>(null);
  const [usage, setUsage] = useState<ChatUsage | null>(null);
  const [interimTranscript, setInterimTranscript] = useState("");

  // Refs mirror state for use inside async flows without stale closures.
  const messagesRef = useRef<ChatMessage[]>([]);
  const stateRef = useRef<SessionState>("idle");
  const abortRef = useRef<AbortController | null>(null);
  const listeningRef = useRef<Listening | null>(null);
  // Monotonic turn counter: a request that outlives its turn must not touch the next one.
  const turnRef = useRef(0);

  const cancelListening = useCallback((): void => {
    const active = listeningRef.current;
    if (!active) return;
    active.cancelled = true;
    listeningRef.current = null;
    active.controller.abort();
    setInterimTranscript("");
  }, []);

  // Unmounting mid-reply or mid-listen must not leave requests or the microphone running.
  useEffect(
    () => () => {
      abortRef.current?.abort();
      cancelListening();
    },
    [cancelListening],
  );

  const updateMessages = useCallback((update: (prev: ChatMessage[]) => ChatMessage[]) => {
    messagesRef.current = update(messagesRef.current);
    setMessages(messagesRef.current);
  }, []);

  const go = useCallback((event: Parameters<typeof transition>[1]) => {
    stateRef.current = transition(stateRef.current, event);
    setState(stateRef.current);
  }, []);
  // Read through a call so TypeScript does not keep a stale narrowing across go() calls.
  const current = useCallback((): SessionState => stateRef.current, []);

  const patch = useCallback(
    (id: string, change: Partial<ChatMessage> | ((m: ChatMessage) => Partial<ChatMessage>)) => {
      updateMessages((prev) =>
        prev.map((m) =>
          m.id === id ? { ...m, ...(typeof change === "function" ? change(m) : change) } : m,
        ),
      );
    },
    [updateMessages],
  );

  const clearNotices = useCallback(() => {
    setError(null);
    setLastRefusal(null);
    setLastFallback(null);
  }, []);

  // One Claude turn for `trimmed`; the caller has already moved the state to `thinking`.
  const runTurn = useCallback(
    async (trimmed: string): Promise<void> => {
      turnRef.current += 1;
      const turn = turnRef.current;
      const isCurrentTurn = (): boolean => turnRef.current === turn;

      const userMessage: ChatMessage = {
        id: newId(),
        role: "user",
        text: trimmed,
        status: "complete",
        createdAt: Date.now(),
      };
      const assistantMessage: ChatMessage = {
        id: newId(),
        role: "assistant",
        text: "",
        status: "streaming",
        createdAt: Date.now(),
      };
      const replay: WireMessage[] = buildHistoryWindow(
        [
          ...messagesRef.current.filter(isReplayable).map(toWire),
          { role: "user", content: trimmed },
        ],
        historyWindow,
      );

      updateMessages((prev) => [...prev, userMessage, assistantMessage]);
      const controller = new AbortController();
      abortRef.current = controller;

      const fail = (message: string): void => {
        patch(userMessage.id, { status: "error" });
        patch(assistantMessage.id, { status: "error" });
        if (!isCurrentTurn()) return;
        setError(message);
        if (current() !== "error") go("FAIL");
      };

      // A reply that is still "streaming" when the turn ends is complete if it has text; an
      // empty one is dropped, because replaying empty content would be rejected by the server.
      const settleAssistant = (): void => {
        updateMessages((prev) =>
          prev.flatMap((m) => {
            if (m.id !== assistantMessage.id || m.status !== "streaming") return [m];
            return m.text ? [{ ...m, status: "complete" as const }] : [];
          }),
        );
      };

      const post = (history: WireMessage[]): Promise<Response> =>
        fetchImpl(`${baseUrl}/chat`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ messages: history }),
          signal: controller.signal,
        });

      try {
        let response = await post(replay);
        if (response.status === 400) {
          // The client window should always satisfy the server's limits, so a 400 means the two
          // disagree (plan §4 step 3): retry once with the oldest half of the turns dropped.
          const reduced = dropOldestTurns(replay);
          if (reduced.length < replay.length) {
            await response.body?.cancel().catch(() => undefined);
            response = await post(reduced);
          }
        }
        if (!response.ok || !response.body) {
          const message = await describeHttpError(response);
          // Stop pressed while the error body was being read: that is a cancellation, not a failure.
          if (controller.signal.aborted) {
            throw new DOMException("The operation was aborted.", "AbortError");
          }
          fail(message);
          return;
        }
        let terminal = false;
        for await (const frame of parseSse(response.body)) {
          const event = parseChatEvent(frame);
          switch (event.type) {
            case "text":
              patch(assistantMessage.id, (m) => ({ text: m.text + event.delta }));
              break;
            case "fallback":
              if (isCurrentTurn()) setLastFallback({ from: event.from, to: event.to });
              break;
            case "refusal":
              // Discard the refused turn from replay history; the transcript keeps it visible.
              patch(userMessage.id, { status: "refused" });
              patch(assistantMessage.id, { status: "refused" });
              if (isCurrentTurn()) {
                setLastRefusal({ category: event.category, explanation: event.explanation });
              }
              terminal = true;
              break;
            case "done":
              patch(assistantMessage.id, { status: "complete" });
              if (isCurrentTurn()) setUsage(event.usage);
              terminal = true;
              break;
            case "error":
              fail(event.message);
              terminal = true;
              break;
          }
          // Terminal events end the turn now; breaking cancels the body (see parseSse).
          if (terminal) break;
        }
        if (!terminal) {
          // EOF without done/refusal/error: the reply is incomplete and must not be replayed.
          fail("Connection closed before the reply finished");
          return;
        }
        settleAssistant();
        if (isCurrentTurn() && current() === "thinking") go("REPLY_DONE");
      } catch (caught) {
        if (controller.signal.aborted) {
          settleAssistant();
          if (isCurrentTurn() && current() !== "idle") go("CANCEL");
        } else {
          fail(caught instanceof Error ? caught.message : "Chat failed");
        }
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [baseUrl, current, fetchImpl, go, historyWindow, patch, updateMessages],
  );

  const sendText = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (current() === "error") go("RESET");
      if (current() !== "idle") return;
      clearNotices();
      go("SEND_TEXT");
      await runTurn(trimmed);
    },
    [clearNotices, current, go, runTurn],
  );

  // Default token source for browser-direct providers: the server mints a short-lived token.
  const getToken = useCallback(
    async (providerId: string): Promise<TokenInfo> => {
      const response = await fetchImpl(`${baseUrl}/token/${encodeURIComponent(providerId)}`, {
        method: "POST",
      });
      if (!response.ok) throw new Error(await describeHttpError(response));
      const data = (await response.json()) as Partial<TokenInfo>;
      if (typeof data.token !== "string" || typeof data.expiresAt !== "number") {
        throw new Error("Invalid token response");
      }
      return { token: data.token, expiresAt: data.expiresAt };
    },
    [baseUrl, fetchImpl],
  );

  // Finalises one listening operation: stop the provider, then send the transcript. Results of
  // an operation that was cancelled or superseded while awaiting are discarded.
  const finishListening = useCallback(
    async (active: Listening): Promise<void> => {
      if (!active.session || active.cancelled || listeningRef.current !== active) return;
      if (current() !== "listening") return;
      go("STOP_LISTENING");
      let text = "";
      try {
        text = (await active.session.stop()).trim();
      } catch (caught) {
        if (active.cancelled || listeningRef.current !== active) return;
        listeningRef.current = null;
        setInterimTranscript("");
        setError(caught instanceof Error ? caught.message : "Transcription failed");
        if (current() === "transcribing") go("FAIL");
        return;
      }
      if (active.cancelled || listeningRef.current !== active) return;
      listeningRef.current = null;
      setInterimTranscript("");
      if (current() !== "transcribing") return;
      if (!text) {
        go("CANCEL");
        return;
      }
      go("TRANSCRIPT_READY");
      await runTurn(text);
    },
    [current, go, runTurn],
  );

  const startListening = useCallback(async (): Promise<void> => {
    if (!stt) {
      setError("No speech-to-text provider configured");
      return;
    }
    if (current() === "error") go("RESET");
    if (current() !== "idle") return;
    clearNotices();
    setInterimTranscript("");
    go("START_LISTENING");

    // Registered before the (possibly slow) provider startup so release/stop/unmount can act.
    const active: Listening = {
      controller: new AbortController(),
      session: null,
      releaseRequested: false,
      cancelled: false,
    };
    listeningRef.current = active;
    const isActive = (): boolean => !active.cancelled && listeningRef.current === active;

    const startOptions: SttStartOptions = {
      onPartial: (text) => {
        if (isActive()) setInterimTranscript(text);
      },
      onFinal: () => {
        if (isActive()) setInterimTranscript("");
      },
      onError: (err) => {
        if (!isActive()) return;
        listeningRef.current = null;
        active.controller.abort();
        setInterimTranscript("");
        setError(err.message);
        if (current() === "listening" || current() === "transcribing") go("FAIL");
      },
      signal: active.controller.signal,
    };
    if (language) startOptions.language = language;
    if (stt.capabilities.needsToken) startOptions.getToken = () => getToken(stt.id);

    try {
      const session = await stt.start(startOptions);
      if (!isActive()) {
        // Cancelled during startup: the provider was told via the signal; make sure it is quiet.
        await session.stop().catch(() => undefined);
        return;
      }
      active.session = session;
      if (active.releaseRequested) await finishListening(active);
    } catch (caught) {
      if (!isActive()) return; // cancelled during startup; stop() already settled the state
      listeningRef.current = null;
      setInterimTranscript("");
      setError(caught instanceof Error ? caught.message : "Could not start listening");
      if (current() === "listening") go("FAIL");
    }
  }, [clearNotices, current, finishListening, getToken, go, language, stt]);

  const stopListening = useCallback(async (): Promise<void> => {
    const active = listeningRef.current;
    if (!active || active.cancelled || current() !== "listening") return;
    if (!active.session) {
      // Released before the provider finished starting: finish as soon as it does.
      active.releaseRequested = true;
      return;
    }
    await finishListening(active);
  }, [current, finishListening]);

  const stop = useCallback((): void => {
    abortRef.current?.abort();
    cancelListening();
    if (current() === "listening" || current() === "transcribing") go("CANCEL");
  }, [cancelListening, current, go]);

  const reset = useCallback((): void => {
    setError(null);
    if (current() === "error") go("RESET");
  }, [current, go]);

  const newConversation = useCallback((): void => {
    abortRef.current?.abort();
    cancelListening();
    turnRef.current += 1; // any in-flight turn is now stale
    updateMessages(() => []);
    clearNotices();
    setUsage(null);
    if (current() === "error") go("RESET");
    else if (current() !== "idle") go("CANCEL");
  }, [cancelListening, clearNotices, current, go, updateMessages]);

  return {
    messages,
    interimTranscript,
    state,
    error,
    lastRefusal,
    lastFallback,
    usage,
    sttProviderId: stt?.id ?? null,
    sendText,
    startListening,
    stopListening,
    stop,
    reset,
    newConversation,
  };
}

// Only completed, non-empty messages are replayed to Claude.
function isReplayable(message: ChatMessage): boolean {
  return message.status === "complete" && message.text.trim() !== "";
}

function toWire(message: ChatMessage): WireMessage {
  return { role: message.role, content: message.text };
}

async function describeHttpError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: unknown };
    if (typeof body.error === "string") return body.error;
  } catch {
    // not JSON
  }
  return `Request failed (${response.status})`;
}
