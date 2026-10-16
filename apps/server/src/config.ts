import type { Effort } from "@voice-chat-kit/server";

export interface ServerConfig {
  /** Bind address; loopback by default so the credential-backed endpoint is not reachable from the LAN. */
  host: string;
  port: number;
  corsOrigin: string;
  anthropic: { apiKey?: string; model?: string; effort?: Effort; maxTokens?: number };
  system: string;
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
  return {
    host: env.HOST || "127.0.0.1",
    port: Number(env.PORT || 3000),
    corsOrigin: env.CORS_ORIGIN || "http://localhost:5173",
    anthropic,
    system: env.VOICE_CHAT_SYSTEM_PROMPT || DEFAULT_SYSTEM_PROMPT,
  };
}
