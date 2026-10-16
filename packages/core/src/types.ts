/** Roles that may appear in the replayed conversation. `system` is never accepted from a client. */
export type Role = "user" | "assistant";

/** A message as sent to `POST /api/chat`. Compatible with the Anthropic `MessageParam` string form. */
export interface WireMessage {
  role: Role;
  content: string;
}

/**
 * Transcript status. Only `complete` messages are replayed to Claude; `refused` and `error`
 * messages stay visible in the UI but never leave the browser again.
 */
export type MessageStatus = "complete" | "streaming" | "refused" | "error";

export interface ChatMessage {
  id: string;
  role: Role;
  text: string;
  status: MessageStatus;
  createdAt: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
}

export interface RefusalInfo {
  category: string | null;
  explanation: string | null;
}

/** Server-sent events emitted by the chat handler; `type` is the SSE `event:` name. */
export type ChatEvent =
  | { type: "text"; delta: string }
  | { type: "fallback"; from: string; to: string }
  | { type: "done"; stopReason: string | null; model: string; usage: ChatUsage }
  | { type: "refusal"; category: string | null; explanation: string | null }
  | { type: "error"; message: string; status?: number };

export interface TokenInfo {
  token: string;
  /** Unix epoch milliseconds. */
  expiresAt: number;
}

export type GetToken = () => Promise<TokenInfo>;

/** Response of `GET /api/providers`: ids of token issuers registered on the server. */
export interface ProvidersInfo {
  tokenIssuers: string[];
}

export interface SttCapabilities {
  streaming: boolean;
  interimResults: boolean;
  runsInBrowser: boolean;
  needsToken: boolean;
}

export interface SttStartOptions {
  language?: string;
  getToken?: GetToken;
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (error: Error) => void;
  signal: AbortSignal;
}

export interface SttSession {
  /** Stops capture and resolves with the final transcript. */
  stop(): Promise<string>;
}

export interface SttProvider {
  readonly id: string;
  readonly capabilities: SttCapabilities;
  /** Browser-only providers report runtime support here; absent means supported. */
  isSupported?(): boolean;
  start(options: SttStartOptions): Promise<SttSession>;
}

export interface TtsCapabilities {
  streamingInput: boolean;
  runsInBrowser: boolean;
  needsToken: boolean;
}

export interface TtsSpeakOptions {
  voice?: string;
  getToken?: GetToken;
  signal: AbortSignal;
  onStart?: () => void;
  onEnd?: () => void;
}

export interface TtsProvider {
  readonly id: string;
  readonly capabilities: TtsCapabilities;
  isSupported?(): boolean;
  /** Speaks sentences as they arrive; resolves when playback of the last one ends or on abort. */
  speak(sentences: AsyncIterable<string>, options: TtsSpeakOptions): Promise<void>;
}

/** Server-side history persistence; implemented in the Mongo phase. */
export interface ConversationStore {
  load(conversationId: string): Promise<WireMessage[]>;
  append(conversationId: string, message: WireMessage): Promise<void>;
}
