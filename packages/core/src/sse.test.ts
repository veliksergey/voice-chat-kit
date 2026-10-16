import { describe, expect, it } from "vitest";
import { parseChatEvent, parseSse, SseFrameParser } from "./sse.js";

describe("SseFrameParser", () => {
  it("parses frames split across arbitrary chunks", () => {
    const parser = new SseFrameParser();
    const a = parser.push("event: text\nda");
    const b = parser.push('ta: {"delta":"hi"}\n\nevent: done\n');
    const c = parser.push("data: {}\n\n");
    expect(a).toEqual([]);
    expect(b).toEqual([{ event: "text", data: '{"delta":"hi"}' }]);
    expect(c).toEqual([{ event: "done", data: "{}" }]);
  });

  it("joins multi-line data, keeps ids, skips comments, and accepts CRLF", () => {
    const parser = new SseFrameParser();
    const frames = parser.push(
      ": keep-alive\r\nid: 7\r\nevent: text\r\ndata: a\r\ndata: b\r\n\r\n",
    );
    expect(frames).toEqual([{ event: "text", data: "a\nb", id: "7" }]);
  });

  it("defaults the event name to message and flushes an unterminated trailing frame", () => {
    const parser = new SseFrameParser();
    expect(parser.push("data: x")).toEqual([]);
    expect(parser.end()).toEqual([{ event: "message", data: "x" }]);
    expect(parser.end()).toEqual([]);
  });

  it("parses a CRLF stream identically at every split position", () => {
    const stream = "event: text\r\ndata: a\r\n\r\nevent: done\r\ndata: {}\r\n\r\n";
    const expected = [
      { event: "text", data: "a" },
      { event: "done", data: "{}" },
    ];
    for (let i = 0; i <= stream.length; i++) {
      const parser = new SseFrameParser();
      const frames = [
        ...parser.push(stream.slice(0, i)),
        ...parser.push(stream.slice(i)),
        ...parser.end(),
      ];
      expect(frames, `split at ${i}`).toEqual(expected);
    }
  });

  it("treats a lone trailing CR as a line break at end of stream", () => {
    const parser = new SseFrameParser();
    expect(parser.push("event: text\rdata: a\r")).toEqual([]);
    expect(parser.end()).toEqual([{ event: "text", data: "a" }]);
  });
});

describe("parseSse", () => {
  const encoder = new TextEncoder();
  const wire = 'event: text\ndata: {"delta":"héllo"}\n\n';
  const expected = [{ event: "text", data: '{"delta":"héllo"}' }];

  function bodyFrom(parts: Uint8Array[]): ReadableStream<Uint8Array> {
    return new ReadableStream<Uint8Array>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    });
  }

  it("decodes a multi-byte character whose bytes arrive in different chunks", async () => {
    const bytes = encoder.encode(wire);
    const cut = encoder.encode('event: text\ndata: {"delta":"h').length + 1; // between the bytes of é
    expect(bytes.length - cut).toBeGreaterThan(0);
    const frames = [];
    for await (const frame of parseSse(bodyFrom([bytes.slice(0, cut), bytes.slice(cut)]))) {
      frames.push(frame);
    }
    expect(frames).toEqual(expected);
  });

  it("yields the same frames for every byte boundary", async () => {
    const bytes = encoder.encode(wire);
    for (let cut = 1; cut < bytes.length; cut++) {
      const frames = [];
      for await (const frame of parseSse(bodyFrom([bytes.slice(0, cut), bytes.slice(cut)]))) {
        frames.push(frame);
      }
      expect(frames, `cut at byte ${cut}`).toEqual(expected);
    }
  });

  it("cancels the body when the consumer stops early", async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(wire));
        // never closes
      },
      cancel() {
        cancelled = true;
      },
    });
    for await (const frame of parseSse(body)) {
      expect(frame.event).toBe("text");
      break;
    }
    expect(cancelled).toBe(true);
  });
});

describe("parseChatEvent", () => {
  it("decodes every event type", () => {
    expect(parseChatEvent({ event: "text", data: '{"delta":"a"}' })).toEqual({
      type: "text",
      delta: "a",
    });
    expect(parseChatEvent({ event: "fallback", data: '{"from":"m1","to":"m2"}' })).toEqual({
      type: "fallback",
      from: "m1",
      to: "m2",
    });
    expect(
      parseChatEvent({
        event: "done",
        data: '{"stopReason":"end_turn","model":"m","usage":{"inputTokens":1,"outputTokens":2,"cacheReadInputTokens":0,"cacheCreationInputTokens":0}}',
      }),
    ).toEqual({
      type: "done",
      stopReason: "end_turn",
      model: "m",
      usage: {
        inputTokens: 1,
        outputTokens: 2,
        cacheReadInputTokens: 0,
        cacheCreationInputTokens: 0,
      },
    });
    expect(
      parseChatEvent({ event: "refusal", data: '{"category":"cyber","explanation":null}' }),
    ).toEqual({ type: "refusal", category: "cyber", explanation: null });
    expect(parseChatEvent({ event: "error", data: '{"message":"boom","status":429}' })).toEqual({
      type: "error",
      message: "boom",
      status: 429,
    });
    expect(parseChatEvent({ event: "error", data: '{"message":"boom"}' })).toEqual({
      type: "error",
      message: "boom",
    });
  });

  it("rejects unknown events and malformed payloads", () => {
    expect(() => parseChatEvent({ event: "nope", data: "{}" })).toThrow(/Unknown chat event/);
    expect(() => parseChatEvent({ event: "text", data: '{"delta":1}' })).toThrow(/delta/);
    expect(() =>
      parseChatEvent({ event: "done", data: '{"model":"m","stopReason":null}' }),
    ).toThrow(/usage/);
  });
});
