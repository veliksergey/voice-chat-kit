// @vitest-environment jsdom
import { renderHook } from "@testing-library/react";
import type { PointerEvent as ReactPointerEvent } from "react";
import { describe, expect, it } from "vitest";
import { usePointerHold } from "./usePointerHold.js";

function harness() {
  const calls: string[] = [];
  const handlers = {
    start: () => {
      calls.push("start");
    },
    release: () => {
      calls.push("release");
    },
  };
  return { calls, handlers };
}

function pointerDown(): ReactPointerEvent<HTMLElement> {
  let prevented = false;
  return {
    preventDefault: () => {
      prevented = true;
    },
    get defaultPrevented() {
      return prevented;
    },
  } as unknown as ReactPointerEvent<HTMLElement>;
}

describe("usePointerHold", () => {
  it("starts on pointer down and releases once on up, leave, or cancel", () => {
    const h = harness();
    const { result } = renderHook(() => usePointerHold(h.handlers));
    const down = pointerDown();
    result.current.onPointerDown(down);
    expect(down.defaultPrevented).toBe(true);
    result.current.onPointerDown(pointerDown()); // second contact while held: ignored
    expect(h.calls).toEqual(["start"]);

    result.current.onPointerLeave();
    result.current.onPointerUp(); // already released
    result.current.onPointerCancel();
    expect(h.calls).toEqual(["start", "release"]);
  });

  it("ignores release events when the pointer did not start the press (Space-held recording)", () => {
    const h = harness();
    const { result } = renderHook(() => usePointerHold(h.handlers));
    result.current.onPointerLeave();
    result.current.onPointerUp();
    result.current.onPointerCancel();
    expect(h.calls).toEqual([]);
  });
});
