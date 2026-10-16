import Anthropic from "@anthropic-ai/sdk";
import type { ProvidersInfo } from "@voice-chat-kit/core";
import {
  type ClaudeChatOptions,
  DEFAULT_CLAUDE_OPTIONS,
  type Effort,
  streamClaudeChat,
} from "./claude.js";
import { sseResponse } from "./sse.js";
import type { TokenIssuer } from "./tokens.js";
import {
  ChatValidationError,
  DEFAULT_LIMITS,
  type ValidationLimits,
  validateChatBody,
} from "./validate.js";

export interface VoiceChatHandlersConfig {
  anthropic?: {
    /** Omit to let the SDK read `ANTHROPIC_API_KEY` or an `ant auth login` profile. */
    apiKey?: string;
    model?: string;
    effort?: Effort;
    maxTokens?: number;
    fallbacks?: boolean;
    /** Injected client (tests); overrides `apiKey`. */
    client?: Anthropic;
  };
  /** System prompt; the client can never change it. */
  system: string;
  tokenIssuers?: TokenIssuer[] | Record<string, TokenIssuer>;
  limits?: Partial<ValidationLimits>;
}

export interface VoiceChatHandlers {
  /** `POST /api/chat` -> SSE stream of chat events. */
  chat(request: Request): Promise<Response>;
  /** `POST /api/token/:provider` -> `{ token, expiresAt }` or 404. */
  token(request: Request, providerId?: string): Promise<Response>;
  /** `GET /api/providers` -> `{ tokenIssuers: [...] }`. */
  providers(request: Request): Response;
  /** `GET /healthz` -> `ok`. */
  health(request: Request): Response;
  readonly options: Readonly<ClaudeChatOptions>;
}

export function healthHandler(_request: Request): Response {
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export function createVoiceChatHandlers(config: VoiceChatHandlersConfig): VoiceChatHandlers {
  const anthropic = config.anthropic ?? {};
  const client =
    anthropic.client ??
    new Anthropic(anthropic.apiKey === undefined ? {} : { apiKey: anthropic.apiKey });
  const options: ClaudeChatOptions = {
    model: anthropic.model ?? DEFAULT_CLAUDE_OPTIONS.model,
    effort: anthropic.effort ?? DEFAULT_CLAUDE_OPTIONS.effort,
    maxTokens: anthropic.maxTokens ?? DEFAULT_CLAUDE_OPTIONS.maxTokens,
    fallbacks: anthropic.fallbacks ?? DEFAULT_CLAUDE_OPTIONS.fallbacks,
    system: config.system,
  };
  const limits: ValidationLimits = { ...DEFAULT_LIMITS, ...config.limits };
  const issuers = new Map<string, TokenIssuer>();
  for (const issuer of Array.isArray(config.tokenIssuers)
    ? config.tokenIssuers
    : Object.values(config.tokenIssuers ?? {})) {
    issuers.set(issuer.id, issuer);
  }

  return {
    options,

    async chat(request) {
      if (request.method !== "POST") return json(405, { error: "Method not allowed" });
      // A browser cannot send application/json cross-site without a CORS preflight, so this
      // also keeps "simple" text/plain POSTs from other pages away from a billable endpoint.
      const contentType = request.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().startsWith("application/json")) {
        return json(415, { error: "Content-Type must be application/json" });
      }
      const declared = Number(request.headers.get("content-length") ?? "0");
      if (declared > limits.maxBodyBytes) {
        return json(400, { error: `Body exceeds ${limits.maxBodyBytes} bytes` });
      }
      let validated: ReturnType<typeof validateChatBody>;
      try {
        validated = validateChatBody(await readBodyWithLimit(request, limits.maxBodyBytes), limits);
      } catch (error) {
        if (error instanceof ChatValidationError)
          return json(error.status, { error: error.message });
        return json(400, { error: "Invalid request" });
      }
      // Cancelling the response body must stop Claude's generation too, not only a request abort.
      const upstream = new AbortController();
      const signal = AbortSignal.any([request.signal, upstream.signal]);
      return sseResponse(streamClaudeChat(client, validated.messages, options, signal), upstream);
    },

    async token(request, providerId) {
      if (request.method !== "POST") return json(405, { error: "Method not allowed" });
      const id = providerId ?? lastPathSegment(request.url);
      const issuer = id ? issuers.get(id) : undefined;
      if (!issuer) return json(404, { error: "Unknown provider" });
      try {
        return json(200, await issuer.issue());
      } catch (error) {
        console.error(
          `[voice-chat-kit] token issuance failed for ${id}:`,
          error instanceof Error ? error.name : typeof error,
        );
        return json(502, { error: "Token issuance failed" });
      }
    },

    providers() {
      const info: ProvidersInfo = { tokenIssuers: [...issuers.keys()] };
      return json(200, info);
    },

    health: healthHandler,
  };
}

// Reads the body incrementally so a chunked upload without Content-Length cannot buffer past
// the limit; the stream is cancelled as soon as the limit is crossed.
async function readBodyWithLimit(request: Request, maxBytes: number): Promise<string> {
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new ChatValidationError(`Body exceeds ${maxBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function lastPathSegment(url: string): string | undefined {
  const segments = new URL(url).pathname.split("/").filter(Boolean);
  return segments.at(-1);
}
