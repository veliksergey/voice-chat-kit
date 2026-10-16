// Abbreviations whose trailing period does not end a sentence. Deliberately short: a missed
// split only delays speech by one sentence, while a false split reads unnaturally.
const ABBREVIATIONS: ReadonlySet<string> = new Set([
  "e.g",
  "i.e",
  "dr",
  "mr",
  "mrs",
  "ms",
  "prof",
  "sr",
  "jr",
  "vs",
  "etc",
  "fig",
  "inc",
  "ltd",
  "approx",
  "dept",
]);

const TERMINATORS: ReadonlySet<string> = new Set([".", "!", "?", "…"]);
const CLOSERS: ReadonlySet<string> = new Set(['"', "'", ")", "]", "”", "’"]);

/**
 * Turns a stream of text deltas into complete sentences so speech can start before the whole
 * reply has arrived. A sentence ends at `.`, `!`, `?` or `…` (plus closing quotes/brackets)
 * followed by whitespace, or at a blank line. Decimals and listed abbreviations do not split.
 */
export class SentenceChunker {
  #buffer = "";

  /** Appends a delta and returns every sentence completed by it. */
  push(delta: string): string[] {
    this.#buffer += delta;
    const out: string[] = [];
    for (;;) {
      const end = findBoundary(this.#buffer);
      if (end < 0) break;
      const sentence = this.#buffer.slice(0, end).trim();
      this.#buffer = this.#buffer.slice(end).replace(/^\s+/, "");
      if (sentence) out.push(sentence);
    }
    return out;
  }

  /** Returns the unterminated remainder (if any) and clears the buffer. Call at end of stream. */
  flush(): string[] {
    const rest = this.#buffer.trim();
    this.#buffer = "";
    return rest ? [rest] : [];
  }

  get pending(): string {
    return this.#buffer;
  }
}

// Index just past the first confirmed sentence boundary, or -1 when more input is needed.
function findBoundary(text: string): number {
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\n" && text[i + 1] === "\n") return i;
    if (ch === undefined || !TERMINATORS.has(ch)) continue;
    let j = i + 1;
    while (j < text.length && CLOSERS.has(text[j] ?? "")) j++;
    if (j >= text.length) return -1;
    if (!/\s/.test(text[j] ?? "")) continue;
    if (ch === "." && isAbbreviation(text, i)) continue;
    return j;
  }
  return -1;
}

function isAbbreviation(text: string, dotIndex: number): boolean {
  const match = /([A-Za-z][A-Za-z.]*)$/.exec(text.slice(0, dotIndex));
  const word = match?.[1];
  if (!word) return false;
  if (word.length === 1 && word === word.toUpperCase()) return true;
  return ABBREVIATIONS.has(word.toLowerCase());
}
