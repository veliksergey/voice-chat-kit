import { describe, expect, it } from "vitest";
import {
  buildHistoryWindow,
  DEFAULT_HISTORY_WINDOW,
  dropOldestTurns,
  historyByteLength,
} from "./history.js";
import type { WireMessage } from "./types.js";

function conversation(turns: number): WireMessage[] {
  const out: WireMessage[] = [];
  for (let i = 1; i <= turns; i++) {
    out.push({ role: "user", content: `question ${i}` });
    out.push({ role: "assistant", content: `answer ${i}` });
  }
  out.push({ role: "user", content: "newest question" });
  return out;
}

const CJK = "漢".repeat(8_000); // 8,000 code points, 24,000 bytes in UTF-8

describe("buildHistoryWindow", () => {
  it("keeps a 30-turn conversation within the caps and preserves the newest user message", () => {
    const window = buildHistoryWindow(conversation(30));
    expect(window.length).toBeLessThanOrEqual(DEFAULT_HISTORY_WINDOW.maxMessages);
    expect(window[0]?.role).toBe("user");
    expect(window.at(-1)).toEqual({ role: "user", content: "newest question" });
    expect(historyByteLength(window)).toBeLessThanOrEqual(DEFAULT_HISTORY_WINDOW.maxBytes);
  });

  it("drops the oldest ten together when the count cap is exceeded by one", () => {
    const window = buildHistoryWindow(conversation(10)); // 21 messages
    expect(window.length).toBe(11);
    expect(window[0]).toEqual({ role: "user", content: "question 6" });
  });

  it("truncates a 20,000-character reply to 8,000 characters plus a marker", () => {
    const long = "x".repeat(20_000);
    const window = buildHistoryWindow([
      { role: "user", content: "hi" },
      { role: "assistant", content: long },
      { role: "user", content: "next" },
    ]);
    // The marker is included in the 8,000-character cap.
    expect(Array.from(window[1]?.content ?? "")).toHaveLength(
      DEFAULT_HISTORY_WINDOW.maxMessageChars,
    );
    expect(window[1]?.content.endsWith(DEFAULT_HISTORY_WINDOW.truncationMarker)).toBe(true);
    expect(window[2]).toEqual({ role: "user", content: "next" });
  });

  it("evicts by bytes with multibyte content and keeps the newest user message", () => {
    const messages: WireMessage[] = [
      { role: "user", content: CJK },
      { role: "assistant", content: CJK },
      { role: "user", content: CJK },
    ];
    expect(historyByteLength(messages)).toBeGreaterThan(DEFAULT_HISTORY_WINDOW.maxBytes);
    const window = buildHistoryWindow(messages);
    expect(window).toEqual([{ role: "user", content: CJK }]);
    expect(historyByteLength(window)).toBeLessThanOrEqual(DEFAULT_HISTORY_WINDOW.maxBytes);
  });

  it("makes progress on consecutive user messages (no user+assistant pair to drop)", () => {
    const messages: WireMessage[] = Array.from({ length: 4 }, (_, i) => ({
      role: "user" as const,
      content: `${i}${CJK}`,
    }));
    const window = buildHistoryWindow(messages);
    expect(window.length).toBeGreaterThan(0);
    expect(window.at(-1)?.content.startsWith("3")).toBe(true);
    expect(historyByteLength(window)).toBeLessThanOrEqual(DEFAULT_HISTORY_WINDOW.maxBytes);
  });

  it("drops a leading assistant message", () => {
    const window = buildHistoryWindow([
      { role: "assistant", content: "orphan" },
      { role: "user", content: "q" },
    ]);
    expect(window).toEqual([{ role: "user", content: "q" }]);
  });

  it("always starts and ends with user and never exceeds the caps", () => {
    for (let turns = 0; turns <= 40; turns += 3) {
      const window = buildHistoryWindow(conversation(turns));
      expect(window.length).toBeGreaterThan(0);
      expect(window[0]?.role).toBe("user");
      expect(window.at(-1)?.role).toBe("user");
      expect(window.length).toBeLessThanOrEqual(DEFAULT_HISTORY_WINDOW.maxMessages);
      expect(historyByteLength(window)).toBeLessThanOrEqual(DEFAULT_HISTORY_WINDOW.maxBytes);
    }
  });

  it("does not mutate its input", () => {
    const input = conversation(2);
    const copy = structuredClone(input);
    buildHistoryWindow(input, { maxMessages: 2, dropCount: 1 });
    expect(input).toEqual(copy);
  });
});

describe("dropOldestTurns", () => {
  it("keeps the newest half of the turns, rounding up, ending with the newest user message", () => {
    const window = dropOldestTurns(conversation(4)); // 5 turns -> keep 3
    expect(window).toEqual([
      { role: "user", content: "question 3" },
      { role: "assistant", content: "answer 3" },
      { role: "user", content: "question 4" },
      { role: "assistant", content: "answer 4" },
      { role: "user", content: "newest question" },
    ]);
    expect(dropOldestTurns(conversation(1))).toEqual([
      { role: "user", content: "newest question" },
    ]);
  });

  it("returns a single turn unchanged and groups a leading assistant message as its own turn", () => {
    const single: WireMessage[] = [{ role: "user", content: "only" }];
    expect(dropOldestTurns(single)).toEqual(single);
    expect(
      dropOldestTurns([
        { role: "assistant", content: "orphan" },
        { role: "user", content: "q" },
      ]),
    ).toEqual([{ role: "user", content: "q" }]);
  });
});
