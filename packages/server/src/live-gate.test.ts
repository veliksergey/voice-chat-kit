import { expect, it } from "vitest";
import { liveEnabled } from "./test-support.js";

it("enables the live smoke test only with LIVE_TESTS=1 and never under CI", () => {
  expect(liveEnabled({})).toBe(false);
  expect(liveEnabled({ LIVE_TESTS: "1" })).toBe(true);
  expect(liveEnabled({ LIVE_TESTS: "1", CI: "1" })).toBe(false);
  expect(liveEnabled({ LIVE_TESTS: "1", CI: "true" })).toBe(false);
  expect(liveEnabled({ LIVE_TESTS: "yes" })).toBe(false);
});
