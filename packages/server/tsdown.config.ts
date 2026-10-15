import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  platform: "node",
  // Emit .js/.d.ts (package is "type": "module"); tsdown defaults node builds to .mjs.
  fixedExtension: false,
  dts: true,
  sourcemap: true,
  clean: true,
});
