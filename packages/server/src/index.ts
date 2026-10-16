export const PACKAGE_NAME = "@voice-chat-kit/server";

export {
  type ClaudeChatOptions,
  DEFAULT_CLAUDE_OPTIONS,
  type Effort,
  streamClaudeChat,
} from "./claude.js";
export { type DeepgramTokenIssuerOptions, deepgramTokenIssuer } from "./deepgram.js";
export {
  createVoiceChatHandlers,
  healthHandler,
  type VoiceChatHandlers,
  type VoiceChatHandlersConfig,
} from "./handlers.js";
export { encodeChatEvent, sseResponse } from "./sse.js";
export type { TokenIssuer } from "./tokens.js";
export {
  ChatValidationError,
  DEFAULT_LIMITS,
  type ValidatedChatBody,
  type ValidationLimits,
  validateChatBody,
} from "./validate.js";
