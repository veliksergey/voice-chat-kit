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
  type TtsProvider,
  transition,
  type WireMessage,
} from "@voice-chat-kit/core";
import { useCallback, useEffect, useRef, useState } from "react";

export interface UseVoiceChatOptions {
  /** Prefix of the server routes, e.g. `/api`. */
  baseUrl: string;
  /** Reserved for Phase 2 (speech-to-text). */
  stt?: SttProvider;
  /** Reserved for Phase 3 (text-to-speech). */
  tts?: TtsProvider;
  fetch?: typeof globalThis.fetch;
  historyWindow?: Partial<HistoryWindowOptions>;
}

export interface FallbackInfo {
  from: string;
  to: string;
}

export interface UseVoiceChatResult {
  messages: ChatMessage[];
  interimTranscript: string;
  state: SessionState;
  error: string | null;
  lastRefusal: RefusalInfo | null;
  lastFallback: FallbackInfo | null;
  usage: ChatUsage | null;
  /** Sends typed text as a user turn and streams the reply. No-op while a turn is in flight. */
  sendText(text: string): Promise<void>;
  /** Aborts the in-flight turn; a partial reply stays in the transcript, an empty one is dropped. */
  stop(): void;
  /** Leaves the error state. */
  reset(): void;
  /** Aborts any turn and clears the transcript, history, and notices. */
  newConversation(): void;
}

let counter = 0;
function newId(): string {
  counter += 1;
  return `m${Date.now().toString(36)}${counter}`;
}

export function useVoiceChat(options: UseVoiceChatOptions): UseVoiceChatResult {
  const { baseUrl, historyWindow } = options;
  const fetchImpl = options.fetch ?? globalThis.fetch;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [state, setState] = useState<SessionState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [lastRefusal, setLastRefusal] = useState<RefusalInfo | null>(null);
  const [lastFallback, setLastFallback] = useState<FallbackInfo | null>(null);
  const [usage, setUsage] = useState<ChatUsage | null>(null);

  // Refs mirror state for use inside async flows without stale closures.
  const messagesRef = useRef<ChatMessage[]>([]);
  const stateRef = useRef<SessionState>("idle");
  const abortRef = useRef<AbortController | null>(null);
  // Monotonic turn counter: a request that outlives its turn must not touch the next one.
  const turnRef = useRef(0);

  // Unmounting mid-reply must not leave the request (and Claude's generation) running.
  useEffect(() => () => abortRef.current?.abort(), []);

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

  const sendText = useCallback(
    async (text: string): Promise<void> => {
      const trimmed = text.trim();
      if (!trimmed) return;
      if (current() === "error") go("RESET");
      if (current() !== "idle") return;

      turnRef.current += 1;
      const turn = turnRef.current;
      const isCurrentTurn = (): boolean => turnRef.current === turn;

      setError(null);
      setLastRefusal(null);
      setLastFallback(null);

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
      go("SEND_TEXT");
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

  const stop = useCallback((): void => {
    abortRef.current?.abort();
  }, []);

  const reset = useCallback((): void => {
    setError(null);
    if (current() === "error") go("RESET");
  }, [current, go]);

  const newConversation = useCallback((): void => {
    abortRef.current?.abort();
    turnRef.current += 1; // any in-flight turn is now stale
    updateMessages(() => []);
    setError(null);
    setLastRefusal(null);
    setLastFallback(null);
    setUsage(null);
    if (current() === "error") go("RESET");
    else if (current() !== "idle") go("CANCEL");
  }, [current, go, updateMessages]);

  return {
    messages,
    interimTranscript: "",
    state,
    error,
    lastRefusal,
    lastFallback,
    usage,
    sendText,
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
