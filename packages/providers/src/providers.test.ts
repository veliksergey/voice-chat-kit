import { expect, it } from "vitest";
import { deepgramStt, webSpeechStt } from "./stt/index.js";
import { SUBPATH as TTS } from "./tts/index.js";

it("exposes the STT adapters and the TTS placeholder entry", () => {
  expect(webSpeechStt().id).toBe("web-speech");
  expect(deepgramStt().id).toBe("deepgram");
  expect(TTS).toBe("@voice-chat-kit/providers/tts");
});
