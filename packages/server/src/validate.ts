import type { WireMessage } from "@voice-chat-kit/core";
import { z } from "zod";

export interface ValidationLimits {
  maxMessages: number;
  /** Per-message cap in Unicode code points. */
  maxMessageChars: number;
  maxBodyBytes: number;
}

// Backstops against direct callers; the client window (core/history) stays well below them.
export const DEFAULT_LIMITS: ValidationLimits = {
  maxMessages: 50,
  maxMessageChars: 16_000,
  maxBodyBytes: 64 * 1024,
};

export class ChatValidationError extends Error {
  readonly status: number = 400;

  constructor(message: string) {
    super(message);
    this.name = "ChatValidationError";
  }
}

export interface ValidatedChatBody {
  messages: WireMessage[];
  conversationId?: string;
}

const textBlock = z.strictObject({ type: z.literal("text"), text: z.string() });
// Emptiness is checked after normalisation so string and text-block forms behave the same.
const content = z.union([z.string(), z.array(textBlock).min(1)]);
// Only user/assistant: Opus 5.5 treats a `system` role in messages as operator authority.
const message = z.strictObject({ role: z.enum(["user", "assistant"]), content });
const bodySchema = z.strictObject({
  messages: z.array(message).min(1),
  conversationId: z.string().min(1).optional(),
});

/** Validates the raw request body for `POST /api/chat`; throws `ChatValidationError` (400). */
export function validateChatBody(
  raw: string,
  limits: ValidationLimits = DEFAULT_LIMITS,
): ValidatedChatBody {
  const bytes = new TextEncoder().encode(raw).length;
  if (bytes > limits.maxBodyBytes) {
    throw new ChatValidationError(`Body exceeds ${limits.maxBodyBytes} bytes`);
  }

  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new ChatValidationError("Body is not valid JSON");
  }

  const parsed = bodySchema.safeParse(json);
  if (!parsed.success) {
    throw new ChatValidationError(describeIssue(parsed.error));
  }

  const messages: WireMessage[] = parsed.data.messages.map((m) => ({
    role: m.role,
    content: typeof m.content === "string" ? m.content : m.content.map((b) => b.text).join(""),
  }));

  if (messages.length > limits.maxMessages) {
    throw new ChatValidationError(`More than ${limits.maxMessages} messages`);
  }
  for (const [index, m] of messages.entries()) {
    if (m.content.trim().length === 0) {
      throw new ChatValidationError(`messages[${index}]: content must not be empty`);
    }
    if (Array.from(m.content).length > limits.maxMessageChars) {
      throw new ChatValidationError(
        `messages[${index}] exceeds ${limits.maxMessageChars} characters`,
      );
    }
  }
  if (messages[0]?.role !== "user") {
    throw new ChatValidationError("First message must be from the user");
  }
  if (messages.at(-1)?.role !== "user") {
    throw new ChatValidationError("Last message must be from the user");
  }

  const result: ValidatedChatBody = { messages };
  if (parsed.data.conversationId !== undefined) {
    result.conversationId = parsed.data.conversationId;
  }
  return result;
}

function describeIssue(error: z.ZodError): string {
  const issue = error.issues[0];
  const path = issue && issue.path.length > 0 ? issue.path.join(".") : "body";
  return `${path}: ${issue?.message ?? "invalid"}`;
}
