import type { ChatEvent, ChatUsage } from "./types.js";

export interface SseFrame {
  event: string;
  data: string;
  id?: string;
}

/** Incremental parser for the `text/event-stream` wire format. Feed decoded text, get frames. */
export class SseFrameParser {
  #buffer = "";
  #pendingCr = false;

  push(chunk: string): SseFrame[] {
    let text = (this.#pendingCr ? "\r" : "") + chunk;
    this.#pendingCr = false;
    // A CR at the very end may be the first half of a CRLF pair split across chunks; keep it
    // back until the next push so it is not normalised into a line break of its own.
    if (text.endsWith("\r")) {
      this.#pendingCr = true;
      text = text.slice(0, -1);
    }
    this.#buffer += text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    const frames: SseFrame[] = [];
    let idx = this.#buffer.indexOf("\n\n");
    while (idx >= 0) {
      const frame = parseFrame(this.#buffer.slice(0, idx));
      this.#buffer = this.#buffer.slice(idx + 2);
      if (frame) frames.push(frame);
      idx = this.#buffer.indexOf("\n\n");
    }
    return frames;
  }

  /** Flushes a trailing frame that was not terminated by a blank line. */
  end(): SseFrame[] {
    if (this.#pendingCr) {
      this.#buffer += "\n";
      this.#pendingCr = false;
    }
    const raw = this.#buffer;
    this.#buffer = "";
    const frame = raw.trim() ? parseFrame(raw) : null;
    return frame ? [frame] : [];
  }
}

function parseFrame(raw: string): SseFrame | null {
  let event = "message";
  let id: string | undefined;
  const data: string[] = [];
  for (const line of raw.split("\n")) {
    if (!line || line.startsWith(":")) continue;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id") id = value;
  }
  if (data.length === 0) return null;
  const frame: SseFrame = { event, data: data.join("\n") };
  if (id !== undefined) frame.id = id;
  return frame;
}

/**
 * Reads a fetch `Response.body` as SSE frames. Leaving the loop early (break/return) cancels
 * the body so the connection is released instead of draining to EOF.
 */
export async function* parseSse(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<SseFrame, void, undefined> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const parser = new SseFrameParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const frame of parser.push(decoder.decode(value, { stream: true }))) yield frame;
    }
    for (const frame of parser.push(decoder.decode())) yield frame;
    for (const frame of parser.end()) yield frame;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/** Decodes one chat SSE frame into a typed event; throws on an unknown event or bad payload. */
export function parseChatEvent(frame: SseFrame): ChatEvent {
  const payload = JSON.parse(frame.data) as Record<string, unknown>;
  switch (frame.event) {
    case "text":
      return { type: "text", delta: str(payload.delta, "delta") };
    case "fallback":
      return { type: "fallback", from: str(payload.from, "from"), to: str(payload.to, "to") };
    case "done":
      return {
        type: "done",
        stopReason: payload.stopReason === null ? null : str(payload.stopReason, "stopReason"),
        model: str(payload.model, "model"),
        usage: usage(payload.usage),
      };
    case "refusal":
      return {
        type: "refusal",
        category: payload.category === null ? null : str(payload.category, "category"),
        explanation: payload.explanation === null ? null : str(payload.explanation, "explanation"),
      };
    case "error": {
      const event: ChatEvent = { type: "error", message: str(payload.message, "message") };
      if (typeof payload.status === "number") event.status = payload.status;
      return event;
    }
    default:
      throw new Error(`Unknown chat event: ${frame.event}`);
  }
}

function str(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Chat event field ${field} must be a string`);
  return value;
}

function num(value: unknown, field: string): number {
  if (typeof value !== "number") throw new Error(`Chat event field ${field} must be a number`);
  return value;
}

function usage(value: unknown): ChatUsage {
  const u = (value ?? {}) as Record<string, unknown>;
  return {
    inputTokens: num(u.inputTokens, "usage.inputTokens"),
    outputTokens: num(u.outputTokens, "usage.outputTokens"),
    cacheReadInputTokens: num(u.cacheReadInputTokens, "usage.cacheReadInputTokens"),
    cacheCreationInputTokens: num(u.cacheCreationInputTokens, "usage.cacheCreationInputTokens"),
  };
}
