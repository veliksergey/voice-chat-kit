import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    // The browser talks to the same origin; Vite forwards /api to apps/server.
    proxy: { "/api": "http://localhost:3000" },
  },
});
