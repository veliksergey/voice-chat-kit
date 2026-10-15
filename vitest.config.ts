import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    environment: "node",
    // Off: the persisted transform bakes resolved import paths into cached test files, so a
    // changed package.json `exports` would not be re-resolved and a broken map could pass.
    fsModuleCache: false,
  },
});
