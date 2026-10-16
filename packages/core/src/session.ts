export const SESSION_STATES = [
  "idle",
  "listening",
  "transcribing",
  "thinking",
  "speaking",
  "error",
] as const;

export type SessionState = (typeof SESSION_STATES)[number];

export const SESSION_EVENTS = [
  "START_LISTENING",
  "STOP_LISTENING",
  "TRANSCRIPT_READY",
  "SEND_TEXT",
  "SPEAK_STARTED",
  "REPLY_DONE",
  "SPEAK_DONE",
  "CANCEL",
  "FAIL",
  "RESET",
] as const;

export type SessionEvent = (typeof SESSION_EVENTS)[number];

// One row per state; an event missing from a row is an illegal transition.
const TABLE: Record<SessionState, Partial<Record<SessionEvent, SessionState>>> = {
  idle: { START_LISTENING: "listening", SEND_TEXT: "thinking", FAIL: "error" },
  listening: { STOP_LISTENING: "transcribing", CANCEL: "idle", FAIL: "error" },
  transcribing: { TRANSCRIPT_READY: "thinking", CANCEL: "idle", FAIL: "error" },
  thinking: { SPEAK_STARTED: "speaking", REPLY_DONE: "idle", CANCEL: "idle", FAIL: "error" },
  speaking: { SPEAK_DONE: "idle", CANCEL: "idle", FAIL: "error" },
  error: { RESET: "idle", CANCEL: "idle" },
};

export class InvalidTransitionError extends Error {
  readonly state: SessionState;
  readonly event: SessionEvent;

  constructor(state: SessionState, event: SessionEvent) {
    super(`Cannot apply ${event} in state ${state}`);
    this.name = "InvalidTransitionError";
    this.state = state;
    this.event = event;
  }
}

export function canTransition(state: SessionState, event: SessionEvent): boolean {
  return TABLE[state][event] !== undefined;
}

/** Returns the next state or throws `InvalidTransitionError`. */
export function transition(state: SessionState, event: SessionEvent): SessionState {
  const next = TABLE[state][event];
  if (next === undefined) {
    throw new InvalidTransitionError(state, event);
  }
  return next;
}
