import { expect, it } from "vitest";
import { createVoiceChatHandlers, healthHandler, PACKAGE_NAME } from "./index.js";

it("exposes the package name and the public factory", () => {
  expect(PACKAGE_NAME).toBe("@voice-chat-kit/server");
  expect(typeof createVoiceChatHandlers).toBe("function");
});

it("healthHandler answers 200 ok", async () => {
  const response = healthHandler(new Request("http://localhost/healthz"));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
});
