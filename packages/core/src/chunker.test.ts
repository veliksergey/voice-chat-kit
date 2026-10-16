import { describe, expect, it } from "vitest";
import { SentenceChunker } from "./chunker.js";

function feed(text: string, chunkSize: number): { pushed: string[]; flushed: string[] } {
  const chunker = new SentenceChunker();
  const pushed: string[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    pushed.push(...chunker.push(text.slice(i, i + chunkSize)));
  }
  return { pushed, flushed: chunker.flush() };
}

describe("SentenceChunker", () => {
  it("yields sentences as they complete regardless of how the text is split", () => {
    const text = "Hello world. How are you? I am fine";
    for (const size of [1, 3, 7, 100]) {
      const { pushed, flushed } = feed(text, size);
      expect(pushed).toEqual(["Hello world.", "How are you?"]);
      expect(flushed).toEqual(["I am fine"]);
    }
  });

  it("does not split on listed abbreviations or initials", () => {
    const { pushed, flushed } = feed(
      "Dr. Smith uses e.g. apples and J. R. Tolkien. Then rests.",
      5,
    );
    expect(pushed).toEqual(["Dr. Smith uses e.g. apples and J. R. Tolkien."]);
    expect(flushed).toEqual(["Then rests."]);
  });

  it("does not split on decimals", () => {
    const { pushed, flushed } = feed("Pi is 3.14 today. Ok", 4);
    expect(pushed).toEqual(["Pi is 3.14 today."]);
    expect(flushed).toEqual(["Ok"]);
  });

  it("keeps closing quotes with the sentence they end", () => {
    const { pushed, flushed } = feed('He said "Stop." Then left.', 6);
    expect(pushed).toEqual(['He said "Stop."']);
    expect(flushed).toEqual(["Then left."]);
  });

  it("treats a blank line as a boundary even without punctuation", () => {
    const { pushed, flushed } = feed("Item one\n\nItem two", 2);
    expect(pushed).toEqual(["Item one"]);
    expect(flushed).toEqual(["Item two"]);
  });

  it("handles ellipses and exclamation marks", () => {
    const { pushed, flushed } = feed("Wait... what? Really! Yes", 3);
    expect(pushed).toEqual(["Wait...", "what?", "Really!"]);
    expect(flushed).toEqual(["Yes"]);
  });

  it("flush on an empty or whitespace-only buffer yields nothing", () => {
    const chunker = new SentenceChunker();
    expect(chunker.flush()).toEqual([]);
    chunker.push("   \n");
    expect(chunker.flush()).toEqual([]);
    expect(chunker.pending).toBe("");
  });
});
