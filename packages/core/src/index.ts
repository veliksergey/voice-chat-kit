export const PACKAGE_NAME = "@voice-chat-kit/core";

export { SentenceChunker } from "./chunker.js";
export {
  buildHistoryWindow,
  DEFAULT_HISTORY_WINDOW,
  dropOldestTurns,
  type HistoryWindowOptions,
  historyByteLength,
} from "./history.js";
export { createSentenceStream, type SentenceStream } from "./sentence-stream.js";
export {
  canTransition,
  InvalidTransitionError,
  SESSION_EVENTS,
  SESSION_STATES,
  type SessionEvent,
  type SessionState,
  transition,
} from "./session.js";
export { parseChatEvent, parseSse, type SseFrame, SseFrameParser } from "./sse.js";
export type * from "./types.js";
