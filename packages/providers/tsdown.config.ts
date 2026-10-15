import { defineConfig } from "tsdown";

export default defineConfig({
  entry: {
    stt: "src/stt/index.ts",
    tts: "src/tts/index.ts",
  },
  format: ["esm"],
  platform: "neutral",
  dts: true,
  sourcemap: true,
  clean: true,
});
