import { expect, it } from "vitest";
import { PACKAGE_NAME } from "./index.js";

it("exposes the package name", () => {
  expect(PACKAGE_NAME).toBe("@voice-chat-kit/react");
});
