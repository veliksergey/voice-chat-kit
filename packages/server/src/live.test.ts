// Opt-in smoke test against the real Claude API: LIVE_TESTS=1 plus credentials
// (ANTHROPIC_API_KEY or an `ant auth login` profile). Never runs by default.
import { type ChatEvent, parseChatEvent, parseSse } from "@voice-chat-kit/core";
import { expect, it } from "vitest";
import { createVoiceChatHandlers } from "./handlers.js";
import { liveEnabled } from "./test-support.js";

const live = liveEnabled(process.env);

it.skipIf(!live)("completes one real turn with Claude", { timeout: 60_000 }, async () => {
  const handlers = createVoiceChatHandlers({
    system: "You are a concise voice assistant. Answer in one short sentence.",
  });
  const response = await handlers.chat(
    new Request("http://localhost/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        messages: [{ role: "user", content: "Say hello in five words or fewer." }],
      }),
    }),
  );
  expect(response.status).toBe(200);
  if (!response.body) throw new Error("no body");
  const events: ChatEvent[] = [];
  for await (const frame of parseSse(response.body)) events.push(parseChatEvent(frame));

  const last = events.at(-1);
  expect(last?.type === "done" || last?.type === "refusal").toBe(true);
  if (last?.type === "done") {
    expect(events.some((e) => e.type === "text")).toBe(true);
    expect(last.usage.outputTokens).toBeGreaterThan(0);
  }
});
