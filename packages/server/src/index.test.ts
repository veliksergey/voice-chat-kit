import { expect, it } from "vitest";
import { healthHandler, PACKAGE_NAME } from "./index.js";

it("exposes the package name", () => {
  expect(PACKAGE_NAME).toBe("@voice-chat-kit/server");
});

it("healthHandler answers 200 ok", async () => {
  const response = healthHandler(new Request("http://localhost/healthz"));
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
});
