import { PACKAGE_NAME } from "@voice-chat-kit/server";
import { expect, it } from "vitest";
import { app } from "./app.js";

// Consumer-side check of the server package's public `exports` entry.
it("resolves the server package's public entry", () => {
  expect(PACKAGE_NAME).toBe("@voice-chat-kit/server");
});

it("GET /healthz returns 200 ok", async () => {
  const response = await app.request("/healthz");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
});
