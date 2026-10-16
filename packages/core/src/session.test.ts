import { describe, expect, it } from "vitest";
import {
  canTransition,
  InvalidTransitionError,
  SESSION_EVENTS,
  SESSION_STATES,
  transition,
} from "./session.js";

describe("session state machine", () => {
  it("follows the voice turn: idle -> listening -> transcribing -> thinking -> speaking -> idle", () => {
    let s = transition("idle", "START_LISTENING");
    expect(s).toBe("listening");
    s = transition(s, "STOP_LISTENING");
    expect(s).toBe("transcribing");
    s = transition(s, "TRANSCRIPT_READY");
    expect(s).toBe("thinking");
    s = transition(s, "SPEAK_STARTED");
    expect(s).toBe("speaking");
    s = transition(s, "SPEAK_DONE");
    expect(s).toBe("idle");
  });

  it("supports the text-only turn: idle -> thinking -> idle", () => {
    expect(transition(transition("idle", "SEND_TEXT"), "REPLY_DONE")).toBe("idle");
  });

  it("allows CANCEL from every non-idle state", () => {
    for (const state of SESSION_STATES) {
      if (state === "idle") continue;
      expect(transition(state, "CANCEL")).toBe("idle");
    }
  });

  it("goes to error on FAIL from every active state, then back to idle on RESET", () => {
    for (const state of SESSION_STATES) {
      if (state === "error") continue;
      expect(transition(state, "FAIL")).toBe("error");
    }
    expect(transition("error", "RESET")).toBe("idle");
  });

  it("rejects illegal transitions with a typed error", () => {
    expect(() => transition("idle", "STOP_LISTENING")).toThrow(InvalidTransitionError);
    expect(() => transition("idle", "CANCEL")).toThrow(/Cannot apply CANCEL in state idle/);
    expect(() => transition("listening", "SEND_TEXT")).toThrow(InvalidTransitionError);
    expect(() => transition("speaking", "START_LISTENING")).toThrow(InvalidTransitionError);
    expect(() => transition("error", "SEND_TEXT")).toThrow(InvalidTransitionError);
  });

  it("canTransition agrees with transition for every state/event pair", () => {
    for (const state of SESSION_STATES) {
      for (const event of SESSION_EVENTS) {
        let ok = true;
        try {
          transition(state, event);
        } catch {
          ok = false;
        }
        expect(canTransition(state, event)).toBe(ok);
      }
    }
  });
});
