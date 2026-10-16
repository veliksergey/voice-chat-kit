import { PACKAGE_NAME as CORE } from "@voice-chat-kit/core";
import { deepgramStt, webSpeechStt } from "@voice-chat-kit/providers/stt";
import { SUBPATH as TTS } from "@voice-chat-kit/providers/tts";
import { PACKAGE_NAME as REACT } from "@voice-chat-kit/react";
import { expect, it } from "vitest";

// Consumer-side check of the development `exports` contract: every public entry of the
// packages this app depends on resolves through pnpm's workspace links without a build.
it("resolves every public entry of the workspace packages", () => {
  expect(CORE).toBe("@voice-chat-kit/core");
  expect(webSpeechStt().id).toBe("web-speech");
  expect(deepgramStt().id).toBe("deepgram");
  expect(TTS).toBe("@voice-chat-kit/providers/tts");
  expect(REACT).toBe("@voice-chat-kit/react");
});
