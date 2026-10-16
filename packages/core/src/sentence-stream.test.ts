import { describe, expect, it } from "vitest";
import { createSentenceStream } from "./sentence-stream.js";

async function collect(stream: AsyncIterable<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const sentence of stream) out.push(sentence);
  return out;
}

describe("createSentenceStream", () => {
  it("yields sentences in order as deltas complete them and flushes the remainder on end", async () => {
    const stream = createSentenceStream();
    const collecting = collect(stream);
    stream.push("Hello th");
    stream.push("ere. How are");
    stream.push(" you? I am");
    stream.end();
    expect(await collecting).toEqual(["Hello there.", "How are you?", "I am"]);
    expect(stream.ended).toBe(true);
  });

  it("wakes a consumer that is already waiting when the next sentence completes", async () => {
    const stream = createSentenceStream();
    const iterator = stream[Symbol.asyncIterator]();
    const first = iterator.next();
    stream.push("One. ");
    expect(await first).toEqual({ value: "One.", done: false });
    const second = iterator.next();
    stream.end();
    expect(await second).toEqual({ value: undefined, done: true });
  });

  it("cancel completes the stream immediately and drops unconsumed sentences", async () => {
    const stream = createSentenceStream();
    stream.push("Keep going. And going. ");
    stream.cancel();
    expect(await collect(stream)).toEqual([]);
    stream.push("Too late. ");
    expect(stream.ended).toBe(true);
  });

  it("ignores pushes after end and completes an idle consumer on cancel", async () => {
    const stream = createSentenceStream();
    stream.end();
    stream.push("Nope. ");
    expect(await collect(stream)).toEqual([]);

    const waiting = createSentenceStream();
    const collecting = collect(waiting);
    await Promise.resolve();
    waiting.cancel();
    expect(await collecting).toEqual([]);
  });

  it("stops when the consumer breaks out early and can be consumed only once", async () => {
    const stream = createSentenceStream();
    stream.push("Alpha. Beta. Gamma. ");
    for await (const sentence of stream) {
      expect(sentence).toBe("Alpha.");
      break;
    }
    expect(stream.ended).toBe(true);
    expect(() => stream[Symbol.asyncIterator]()).toThrow(/consumed once/);
  });
});
