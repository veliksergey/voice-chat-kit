import { expect, it } from "vitest";
import { deepgramStt, webSpeechStt } from "./stt/index.js";
import { deepgramTts, webSpeechTts } from "./tts/index.js";

it("exposes the STT and TTS adapters", () => {
  expect(webSpeechStt().id).toBe("web-speech");
  expect(deepgramStt().id).toBe("deepgram");
  expect(webSpeechTts().id).toBe("web-speech");
  expect(deepgramTts().id).toBe("deepgram");
});
