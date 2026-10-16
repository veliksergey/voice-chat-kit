import type { TokenInfo } from "@voice-chat-kit/core";
import type { TokenIssuer } from "./tokens.js";

export interface DeepgramTokenIssuerOptions {
  /** Deepgram project API key (Member or higher). Stays on the server. */
  apiKey: string;
  /** Token lifetime; Deepgram defaults to 30 s and allows up to 3600. Plan §8 uses 60. */
  ttlSeconds?: number;
  fetch?: typeof globalThis.fetch;
  baseUrl?: string;
}

/**
 * Mints short-lived Deepgram JWTs via `POST /v1/auth/grant` so the browser can open the
 * streaming WebSocket directly without ever seeing the API key.
 */
export function deepgramTokenIssuer(options: DeepgramTokenIssuerOptions): TokenIssuer {
  const ttlSeconds = options.ttlSeconds ?? 60;
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const baseUrl = (options.baseUrl ?? "https://api.deepgram.com").replace(/\/$/, "");

  return {
    id: "deepgram",
    async issue(): Promise<TokenInfo> {
      const response = await fetchImpl(`${baseUrl}/v1/auth/grant`, {
        method: "POST",
        headers: {
          authorization: `Token ${options.apiKey}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ ttl_seconds: ttlSeconds }),
      });
      if (!response.ok) {
        // Status only: the upstream body is not forwarded and the key is never logged.
        throw new Error(`Deepgram token grant failed (${response.status})`);
      }
      const data = (await response.json()) as { access_token?: unknown; expires_in?: unknown };
      if (typeof data.access_token !== "string" || data.access_token.length === 0) {
        throw new Error("Deepgram token grant returned no access_token");
      }
      const expiresIn = typeof data.expires_in === "number" ? data.expires_in : ttlSeconds;
      return { token: data.access_token, expiresAt: Date.now() + expiresIn * 1000 };
    },
  };
}
