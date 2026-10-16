import { serve } from "@hono/node-server";
import { createVoiceChatHandlers } from "@voice-chat-kit/server";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";

// .env is optional and lives at the repository root (see .env.example); when started from
// apps/server (pnpm dev) it is two levels up. Deployments inject real variables instead.
for (const candidate of [".env", "../../.env"]) {
  try {
    process.loadEnvFile(candidate);
    break;
  } catch {
    // try the next location
  }
}

const config = loadConfig();
const handlers = createVoiceChatHandlers({ anthropic: config.anthropic, system: config.system });
const app = createApp(handlers, { corsOrigin: config.corsOrigin });

// Loopback by default: /api/chat spends your Claude credits and has no auth in v1.
serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(
    `voice-chat-kit server listening on http://${info.address}:${info.port} (model ${handlers.options.model}, effort ${handlers.options.effort}, CORS ${config.corsOrigin})`,
  );
});
