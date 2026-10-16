// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { isPushToTalkTarget, usePushToTalkKey } from "./usePushToTalkKey.js";

function harness(active = false) {
  const calls: string[] = [];
  const handlers = {
    start: () => {
      calls.push("start");
    },
    release: () => {
      calls.push("release");
    },
    cancel: () => {
      calls.push("cancel");
    },
    isActive: () => active,
  };
  return { calls, handlers };
}

function key(type: "keydown" | "keyup", target: EventTarget, repeat = false): KeyboardEvent {
  const event = new KeyboardEvent(type, { code: "Space", repeat, bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("usePushToTalkKey", () => {
  it("starts on Space down, ignores key repeat, and releases on Space up", () => {
    const h = harness();
    renderHook(() => usePushToTalkKey(h.handlers));
    act(() => {
      key("keydown", document.body);
      key("keydown", document.body, true);
      key("keydown", document.body);
    });
    expect(h.calls).toEqual(["start"]);
    act(() => {
      key("keyup", document.body);
    });
    expect(h.calls).toEqual(["start", "release"]);
    // A keyup without a held press (e.g. after the window regained focus) does nothing.
    act(() => {
      key("keyup", document.body);
    });
    expect(h.calls).toEqual(["start", "release"]);
  });

  it("cancels a held press when the window loses focus and ignores the late keyup", () => {
    const h = harness();
    renderHook(() => usePushToTalkKey(h.handlers));
    act(() => {
      key("keydown", document.body);
      window.dispatchEvent(new Event("blur"));
    });
    expect(h.calls).toEqual(["start", "cancel"]);
    act(() => {
      key("keyup", document.body);
    });
    expect(h.calls).toEqual(["start", "cancel"]);
  });

  it("cancels when the document becomes hidden, also for a pointer-driven recording", () => {
    const h = harness(true); // recording in progress, not via the key
    renderHook(() => usePushToTalkKey(h.handlers));
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    act(() => {
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(h.calls).toEqual(["cancel"]);
    Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
  });

  it("leaves Space alone on focused controls other than the push-to-talk button", () => {
    const h = harness();
    renderHook(() => usePushToTalkKey(h.handlers));
    const stopButton = document.createElement("button");
    const ptt = document.createElement("button");
    ptt.dataset.ptt = "true";
    const select = document.createElement("select");
    const input = document.createElement("input");
    document.body.append(stopButton, ptt, select, input);

    const onStop = key("keydown", stopButton);
    expect(onStop.defaultPrevented).toBe(false);
    key("keydown", select);
    key("keydown", input);
    expect(h.calls).toEqual([]);

    const onPtt = key("keydown", ptt);
    expect(onPtt.defaultPrevented).toBe(true);
    key("keyup", ptt);
    expect(h.calls).toEqual(["start", "release"]);
  });

  it("does nothing when disabled", () => {
    const h = harness();
    renderHook(() => usePushToTalkKey(h.handlers, { enabled: false }));
    act(() => {
      key("keydown", document.body);
      key("keyup", document.body);
    });
    expect(h.calls).toEqual([]);
  });

  it("isPushToTalkTarget accepts the page and the PTT button only", () => {
    expect(isPushToTalkTarget(null)).toBe(true);
    expect(isPushToTalkTarget(document.body)).toBe(true);
    expect(isPushToTalkTarget(document.documentElement)).toBe(true);
    const plain = document.createElement("div");
    expect(isPushToTalkTarget(plain)).toBe(false);
    plain.dataset.ptt = "true";
    expect(isPushToTalkTarget(plain)).toBe(true);
    expect(isPushToTalkTarget(document.createElement("textarea"))).toBe(false);
  });
});
