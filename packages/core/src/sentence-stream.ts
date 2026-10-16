import { SentenceChunker } from "./chunker.js";

/**
 * Bridges a streaming reply to a `TtsProvider`: text deltas go in, complete sentences come out
 * as an async iterable the provider consumes while the reply is still arriving.
 */
export interface SentenceStream extends AsyncIterable<string> {
  /** Feeds a text delta; every sentence it completes becomes available to the consumer. */
  push(delta: string): void;
  /** No more text: flushes the unterminated remainder as a last sentence and completes. */
  end(): void;
  /** Completes immediately, dropping sentences not yet consumed (refusal, stop, error). */
  cancel(): void;
  readonly ended: boolean;
}

export function createSentenceStream(): SentenceStream {
  const chunker = new SentenceChunker();
  const queue: string[] = [];
  let done = false;
  let consumed = false;
  let wake: (() => void) | null = null;

  const notify = (): void => {
    const resolve = wake;
    wake = null;
    resolve?.();
  };

  const iterator: AsyncIterator<string> = {
    async next(): Promise<IteratorResult<string>> {
      for (;;) {
        const sentence = queue.shift();
        if (sentence !== undefined) return { value: sentence, done: false };
        if (done) return { value: undefined, done: true };
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    },
    async return(): Promise<IteratorResult<string>> {
      // The consumer stopped early (e.g. provider aborted): drop what is left.
      done = true;
      queue.length = 0;
      return { value: undefined, done: true };
    },
  };

  return {
    push(delta: string): void {
      if (done) return;
      queue.push(...chunker.push(delta));
      if (queue.length > 0) notify();
    },
    end(): void {
      if (done) return;
      queue.push(...chunker.flush());
      done = true;
      notify();
    },
    cancel(): void {
      done = true;
      queue.length = 0;
      notify();
    },
    get ended(): boolean {
      return done;
    },
    [Symbol.asyncIterator](): AsyncIterator<string> {
      if (consumed) throw new Error("A sentence stream can be consumed once");
      consumed = true;
      return iterator;
    },
  };
}
