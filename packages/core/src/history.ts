import type { WireMessage } from "./types.js";

export interface HistoryWindowOptions {
  /** Per-message cap in Unicode code points; longer content is cut and marked. */
  maxMessageChars: number;
  /** When exceeded, the oldest `dropCount` messages go at once so the cached prefix stays stable. */
  maxMessages: number;
  dropCount: number;
  /** Cap on the UTF-8 size of `JSON.stringify({ messages })`. */
  maxBytes: number;
  truncationMarker: string;
}

export const DEFAULT_HISTORY_WINDOW: HistoryWindowOptions = {
  maxMessageChars: 8_000,
  maxMessages: 20,
  dropCount: 10,
  maxBytes: 48 * 1024,
  truncationMarker: "…",
};

/**
 * Builds the bounded history sent to `POST /api/chat`. Deterministic and independent of token
 * counts: truncate each message, then drop by count, then drop whole turns by bytes, then drop
 * a leading assistant message. The newest message is never dropped.
 */
export function buildHistoryWindow(
  messages: readonly WireMessage[],
  options: Partial<HistoryWindowOptions> = {},
): WireMessage[] {
  const o: HistoryWindowOptions = { ...DEFAULT_HISTORY_WINDOW, ...options };
  let window: WireMessage[] = messages.map((m) => ({
    role: m.role,
    content: truncate(m.content, o.maxMessageChars, o.truncationMarker),
  }));

  while (window.length > o.maxMessages) {
    window = window.slice(Math.min(o.dropCount, window.length - 1));
  }

  while (window.length > 1 && byteLength(window) > o.maxBytes) {
    window = dropOldestTurn(window);
  }

  while (window.length > 1 && window[0]?.role === "assistant") {
    window = window.slice(1);
  }

  return window;
}

export function historyByteLength(messages: readonly WireMessage[]): number {
  return byteLength(messages);
}

/**
 * Keeps the newest half of the turns (a `user` message plus the assistant messages that follow
 * it). The client uses it for the single retry after the server rejects a window with 400.
 * A single turn is returned unchanged.
 */
export function dropOldestTurns(messages: readonly WireMessage[]): WireMessage[] {
  const turns: WireMessage[][] = [];
  for (const message of messages) {
    const last = turns.at(-1);
    if (message.role === "user" || !last) turns.push([message]);
    else last.push(message);
  }
  if (turns.length <= 1) return [...messages];
  const keep = Math.ceil(turns.length / 2);
  return turns.slice(turns.length - keep).flat();
}

// The marker counts toward the cap so a truncated message never exceeds `maxChars`.
function truncate(text: string, maxChars: number, marker: string): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - Array.from(marker).length);
  return chars.slice(0, keep).join("") + marker;
}

function byteLength(messages: readonly WireMessage[]): number {
  return new TextEncoder().encode(JSON.stringify({ messages })).length;
}

// A turn is a user message plus the assistant message that follows it, if any. Dropping per turn
// (not per pair) keeps making progress when the history holds consecutive user messages.
function dropOldestTurn(window: WireMessage[]): WireMessage[] {
  const count = window[0]?.role === "user" && window[1]?.role === "assistant" ? 2 : 1;
  return window.slice(Math.min(count, window.length - 1));
}
