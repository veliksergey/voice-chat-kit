import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  // Emit dist/index.js (the start script's target); tsdown defaults node builds to .mjs.
  fixedExtension: false,
  // Bundle workspace packages: their dev `exports` point at .ts sources (see AGENTS.md).
  deps: { alwaysBundle: [/^@voice-chat-kit\//] },
  dts: false,
  sourcemap: true,
  clean: true,
});
