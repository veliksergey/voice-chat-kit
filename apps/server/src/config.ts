import type Anthropic from "@anthropic-ai/sdk";
import {
  createVoiceChatHandlers,
  deepgramTokenIssuer,
  type Effort,
  type TokenIssuer,
  type VoiceChatHandlers,
} from "@voice-chat-kit/server";

export interface ServerConfig {
  /** Bind address; loopback by default so the credential-backed endpoint is not reachable from the LAN. */
  host: string;
  port: number;
  corsOrigin: string;
  anthropic: { apiKey?: string; model?: string; effort?: Effort; maxTokens?: number };
  system: string;
  /** Present only when DEEPGRAM_API_KEY is set; enables the `deepgram` token issuer. */
  deepgramApiKey?: string;
}

const EFFORTS: ReadonlySet<string> = new Set(["low", "medium", "high", "xhigh", "max"]);

export const DEFAULT_SYSTEM_PROMPT =
  "You are a concise voice assistant. Reply in one or two spoken sentences unless asked for detail.";

/** Reads configuration from environment variables; keys stay on the server. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const anthropic: ServerConfig["anthropic"] = {};
  if (env.ANTHROPIC_API_KEY) anthropic.apiKey = env.ANTHROPIC_API_KEY;
  // VOICE_CHAT_* rather than CLAUDE_*: Claude Code exports CLAUDE_EFFORT into every shell it
  // runs, and a generic name would silently reconfigure this server.
  if (env.VOICE_CHAT_MODEL) anthropic.model = env.VOICE_CHAT_MODEL;
  if (env.VOICE_CHAT_EFFORT) {
    if (!EFFORTS.has(env.VOICE_CHAT_EFFORT)) {
      throw new Error(
        `VOICE_CHAT_EFFORT must be one of low, medium, high, xhigh, max (got ${env.VOICE_CHAT_EFFORT})`,
      );
    }
    anthropic.effort = env.VOICE_CHAT_EFFORT as Effort;
  }
  if (env.VOICE_CHAT_MAX_TOKENS) {
    const n = Number(env.VOICE_CHAT_MAX_TOKENS);
    if (!Number.isInteger(n) || n <= 0)
      throw new Error("VOICE_CHAT_MAX_TOKENS must be a positive integer");
    anthropic.maxTokens = n;
  }
  // `||` not `??`: the .env.example template leaves optional values blank, and blank means unset.
  const config: ServerConfig = {
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 3000),
    corsOrigin: env.CORS_ORIGIN || "http://localhost:5173",
    anthropic,
    system: env.VOICE_CHAT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
  };
  if (env.DEEPGRAM_API_KEY) config.deepgramApiKey = env.DEEPGRAM_API_KEY;
  return config;
}

export interface HandlerOverrides {
  /** Injected Anthropic client (tests). */
  anthropicClient?: Anthropic;
  /** `fetch` used by token issuers (tests). */
  fetch?: typeof globalThis.fetch;
}

/** Builds the handlers from config: Claude settings plus the token issuers the keys enable. */
export function createHandlersFromConfig(
  config: ServerConfig,
  overrides: HandlerOverrides = {},
): VoiceChatHandlers {
  const tokenIssuers: TokenIssuer[] = [];
  if (config.deepgramApiKey) {
    const issuerOptions: Parameters<typeof deepgramTokenIssuer>[0] = {
      apiKey: config.deepgramApiKey,
      ttlSeconds: 60,
    };
    if (overrides.fetch) issuerOptions.fetch = overrides.fetch;
    tokenIssuers.push(deepgramTokenIssuer(issuerOptions));
  }
  const anthropic: NonNullable<Parameters<typeof createVoiceChatHandlers>[0]["anthropic"]> = {
    ...config.anthropic,
  };
  if (overrides.anthropicClient) anthropic.client = overrides.anthropicClient;
  return createVoiceChatHandlers({ anthropic, system: config.system, tokenIssuers });
}
