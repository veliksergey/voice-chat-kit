import type { TokenInfo } from "@voice-chat-kit/core";

/**
 * Mints a short-lived credential for a browser-direct provider. Registered on the server under
 * the provider id; the vendor API key never leaves the server.
 */
export interface TokenIssuer {
  readonly id: string;
  issue(): Promise<TokenInfo>;
}
