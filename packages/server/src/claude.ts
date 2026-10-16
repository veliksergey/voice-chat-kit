import Anthropic from "@anthropic-ai/sdk";
import type { ChatEvent, WireMessage } from "@voice-chat-kit/core";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export interface ClaudeChatOptions {
  model: string;
  effort: Effort;
  maxTokens: number;
  system: string;
  /** Server-side refusal fallback (`fallbacks: "default"`); on by default. */
  fallbacks: boolean;
}

export const DEFAULT_CLAUDE_OPTIONS: Omit<ClaudeChatOptions, "system"> = {
  model: "claude-opus-5-5",
  effort: "low",
  maxTokens: 4096,
  fallbacks: true,
};

/**
 * Streams one Claude turn as chat events. Never throws: API failures become an `error` event,
 * and a client abort (via `signal`) ends the stream silently.
 */
export async function* streamClaudeChat(
  client: Anthropic,
  messages: readonly WireMessage[],
  options: ClaudeChatOptions,
  signal: AbortSignal,
): AsyncGenerator<ChatEvent, void, undefined> {
  const fallbackParams = options.fallbacks
    ? { fallbacks: "default" as const, betas: ["server-side-fallback-2026-07-01" as const] }
    : {};

  const stream = client.beta.messages.stream(
    {
      model: options.model,
      max_tokens: options.maxTokens,
      // Automatic caching: the breakpoint moves to the last cacheable block each request.
      cache_control: { type: "ephemeral" },
      system: options.system,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      output_config: { effort: options.effort },
      ...fallbackParams,
    },
    { signal },
  );

  try {
    for await (const event of stream) {
      if (event.type === "content_block_start" && event.content_block.type === "fallback") {
        yield {
          type: "fallback",
          from: event.content_block.from.model,
          to: event.content_block.to.model,
        };
      } else if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
        yield { type: "text", delta: event.delta.text };
      }
    }
    const message = await stream.finalMessage();
    if (message.stop_reason === "refusal") {
      yield {
        type: "refusal",
        category: message.stop_details?.category ?? null,
        explanation: message.stop_details?.explanation ?? null,
      };
      return;
    }
    yield {
      type: "done",
      stopReason: message.stop_reason,
      model: message.model,
      usage: {
        inputTokens: message.usage.input_tokens,
        outputTokens: message.usage.output_tokens,
        cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
        cacheCreationInputTokens: message.usage.cache_creation_input_tokens ?? 0,
      },
    };
  } catch (error) {
    if (signal.aborted) return;
    yield toErrorEvent(error);
  }
}

// Generic messages only: the client must never see upstream error bodies or internals.
function toErrorEvent(error: unknown): ChatEvent {
  if (error instanceof Anthropic.APIError) {
    console.error(`[voice-chat-kit] Claude API error: ${error.name} ${error.status ?? ""}`.trim());
    const event: ChatEvent = {
      type: "error",
      message: `Claude API error (${error.status ?? "network"})`,
    };
    if (error.status !== undefined) event.status = error.status;
    return event;
  }
  console.error(
    "[voice-chat-kit] chat failed:",
    error instanceof Error ? error.name : typeof error,
  );
  return { type: "error", message: "Chat failed" };
}
