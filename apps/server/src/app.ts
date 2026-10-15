import { healthHandler } from "@voice-chat-kit/server";
import { Hono } from "hono";

export const app = new Hono();

app.get("/healthz", (c) => healthHandler(c.req.raw));
