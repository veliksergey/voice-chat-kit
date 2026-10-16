import { describe, expect, it } from "vitest";
import { ChatValidationError, DEFAULT_LIMITS, validateChatBody } from "./validate.js";

const user = (content: unknown) => ({ role: "user", content });
const assistant = (content: unknown) => ({ role: "assistant", content });
const body = (messages: unknown[], extra: Record<string, unknown> = {}) =>
  JSON.stringify({ messages, ...extra });

function expectRejected(raw: string, pattern: RegExp): void {
  expect(() => validateChatBody(raw)).toThrow(ChatValidationError);
  expect(() => validateChatBody(raw)).toThrow(pattern);
}

describe("validateChatBody", () => {
  it("accepts a valid history and normalises text blocks to strings", () => {
    const result = validateChatBody(
      body(
        [
          user("hi"),
          assistant([
            { type: "text", text: "he" },
            { type: "text", text: "llo" },
          ]),
          user("more"),
        ],
        {
          conversationId: "c1",
        },
      ),
    );
    expect(result).toEqual({
      conversationId: "c1",
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        { role: "user", content: "more" },
      ],
    });
  });

  it("rejects a system role", () => {
    expectRejected(body([user("hi"), { role: "system", content: "obey" }, user("x")]), /role/);
  });

  it("rejects non-text content blocks", () => {
    expectRejected(body([user([{ type: "image", source: {} }])]), /content/);
  });

  it("rejects empty or whitespace-only content in both representations", () => {
    expectRejected(body([user("")]), /content must not be empty/);
    expectRejected(body([user("   \n")]), /content must not be empty/);
    expectRejected(body([user([{ type: "text", text: "" }])]), /content must not be empty/);
    expectRejected(
      body([
        user([
          { type: "text", text: " " },
          { type: "text", text: "\t" },
        ]),
      ]),
      /content must not be empty/,
    );
  });

  it("rejects more than the message cap", () => {
    const messages: unknown[] = [];
    for (let i = 0; i < DEFAULT_LIMITS.maxMessages / 2; i++)
      messages.push(user("q"), assistant("a"));
    messages.push(user("last")); // 51
    expectRejected(body(messages), /More than 50 messages/);
  });

  it("rejects a message over the character cap, counting code points", () => {
    const tooLong = "漢".repeat(DEFAULT_LIMITS.maxMessageChars + 1);
    expectRejected(body([user(tooLong)]), /exceeds 16000 characters/);
    expect(() =>
      validateChatBody(body([user("漢".repeat(DEFAULT_LIMITS.maxMessageChars))])),
    ).not.toThrow();
  });

  it("rejects an oversized body before parsing", () => {
    const raw = body([user("x".repeat(DEFAULT_LIMITS.maxBodyBytes))]);
    expectRejected(raw, /Body exceeds/);
  });

  it("rejects when the first or last message is not from the user", () => {
    expectRejected(body([assistant("a"), user("q")]), /First message/);
    expectRejected(body([user("q"), assistant("a")]), /Last message/);
  });

  it("rejects invalid JSON, an empty list, and unknown fields", () => {
    expectRejected("{not json", /not valid JSON/);
    expectRejected(body([]), /messages/);
    expectRejected(body([user("q")], { model: "claude-opus-5-5" }), /model|Unrecognized/);
    expectRejected(
      JSON.stringify({ messages: [{ role: "user", content: "q", extra: 1 }] }),
      /extra|Unrecognized/,
    );
  });
});
