import type { VoiceChatHandlers } from "@voice-chat-kit/server";
import { Hono } from "hono";
import { cors } from "hono/cors";

export interface AppOptions {
  corsOrigin: string;
}

/** Mounts the voice-chat-kit handlers: /healthz, /api/chat, /api/token/:provider, /api/providers. */
export function createApp(handlers: VoiceChatHandlers, options: AppOptions): Hono {
  const app = new Hono();

  // CORS headers only decide whether a browser may read the response; a page on another origin
  // can still fire a "simple" POST at loopback. Reject foreign origins before any billable handler.
  app.use("/api/*", async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && origin !== options.corsOrigin) {
      return c.json({ error: "Origin not allowed" }, 403);
    }
    await next();
  });
  app.use("/api/*", cors({ origin: options.corsOrigin, allowMethods: ["GET", "POST", "OPTIONS"] }));

  app.get("/healthz", (c) => handlers.health(c.req.raw));
  app.post("/api/chat", (c) => handlers.chat(c.req.raw));
  app.post("/api/token/:provider", (c) => handlers.token(c.req.raw, c.req.param("provider")));
  app.get("/api/providers", (c) => handlers.providers(c.req.raw));
  return app;
}
