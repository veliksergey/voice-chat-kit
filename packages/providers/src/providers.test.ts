import { expect, it } from "vitest";
import { SUBPATH as STT } from "./stt/index.js";
import { SUBPATH as TTS } from "./tts/index.js";

it("exposes both subpath entries", () => {
  expect(STT).toBe("@voice-chat-kit/providers/stt");
  expect(TTS).toBe("@voice-chat-kit/providers/tts");
});
