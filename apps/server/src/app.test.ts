import Anthropic from "@anthropic-ai/sdk";
import { createVoiceChatHandlers, PACKAGE_NAME } from "@voice-chat-kit/server";
import { expect, it } from "vitest";
import { createApp } from "./app.js";
import { createHandlersFromConfig, DEFAULT_SYSTEM_PROMPT, loadConfig } from "./config.js";

const ORIGIN = "http://localhost:5173";

function app() {
  // A client whose fetch must never run: these tests cover routing and CORS only.
  const client = new Anthropic({
    apiKey: "unused",
    maxRetries: 0,
    fetch: () => {
      throw new Error("Claude must not be called");
    },
  });
  const handlers = createVoiceChatHandlers({ anthropic: { client }, system: "test" });
  return createApp(handlers, { corsOrigin: ORIGIN });
}

it("resolves the server package's public entry", () => {
  expect(PACKAGE_NAME).toBe("@voice-chat-kit/server");
});

it("GET /healthz returns 200 ok", async () => {
  const response = await app().request("/healthz");
  expect(response.status).toBe(200);
  expect(await response.text()).toBe("ok");
});

it("routes the api handlers and applies CORS to the configured origin only", async () => {
  const a = app();

  const providers = await a.request("/api/providers", { headers: { origin: ORIGIN } });
  expect(providers.status).toBe(200);
  expect(await providers.json()).toEqual({ tokenIssuers: [] });
  expect(providers.headers.get("access-control-allow-origin")).toBe(ORIGIN);

  const other = await a.request("/api/providers", { headers: { origin: "http://evil.example" } });
  expect(other.headers.get("access-control-allow-origin")).toBeNull();

  const preflight = await a.request("/api/chat", {
    method: "OPTIONS",
    headers: { origin: ORIGIN, "access-control-request-method": "POST" },
  });
  expect(preflight.status).toBe(204);
  expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");

  const token = await a.request("/api/token/nope", { method: "POST" });
  expect(token.status).toBe(404);

  const badChat = await a.request("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      messages: [
        { role: "system", content: "x" },
        { role: "user", content: "q" },
      ],
    }),
  });
  expect(badChat.status).toBe(400);
});

it("rejects a cross-site simple POST before the chat handler can spend credits", async () => {
  let upstreamCalls = 0;
  const client = new Anthropic({
    apiKey: "unused",
    maxRetries: 0,
    fetch: () => {
      upstreamCalls += 1;
      throw new Error("Claude must not be called");
    },
  });
  const handlers = createVoiceChatHandlers({ anthropic: { client }, system: "test" });
  const a = createApp(handlers, { corsOrigin: ORIGIN });
  const body = JSON.stringify({ messages: [{ role: "user", content: "hi" }] });

  // Valid JSON under text/plain needs no preflight: this is what a malicious page can send.
  const foreign = await a.request("/api/chat", {
    method: "POST",
    headers: { origin: "http://attacker.example", "content-type": "text/plain" },
    body,
  });
  expect(foreign.status).toBe(403);
  expect(upstreamCalls).toBe(0);

  // The allowed origin gets past the origin gate; the handler itself still refuses text/plain.
  const allowedOrigin = await a.request("/api/chat", {
    method: "POST",
    headers: { origin: ORIGIN, "content-type": "text/plain" },
    body,
  });
  expect(allowedOrigin.status).toBe(415);
  expect(upstreamCalls).toBe(0);
});

it("loads configuration from the environment and validates effort", () => {
  const config = loadConfig({
    ANTHROPIC_API_KEY: "k",
    VOICE_CHAT_MODEL: "claude-opus-5-5",
    VOICE_CHAT_EFFORT: "medium",
    PORT: "4000",
    CORS_ORIGIN: "http://localhost:4173",
  });
  expect(config).toMatchObject({
    port: 4000,
    corsOrigin: "http://localhost:4173",
    anthropic: { apiKey: "k", model: "claude-opus-5-5", effort: "medium" },
  });
  expect(() => loadConfig({ VOICE_CHAT_EFFORT: "turbo" })).toThrow(/VOICE_CHAT_EFFORT/);
  expect(loadConfig({}).anthropic).toEqual({});
  // Claude Code exports CLAUDE_EFFORT into its shells; the server must not pick it up.
  expect(loadConfig({ CLAUDE_EFFORT: "xhigh", CLAUDE_MODEL: "x" }).anthropic).toEqual({});
  // Loopback unless HOST is set explicitly.
  expect(loadConfig({}).host).toBe("127.0.0.1");
  expect(loadConfig({ HOST: "0.0.0.0" }).host).toBe("0.0.0.0");
});

it("registers the Deepgram token issuer only when DEEPGRAM_API_KEY is set", async () => {
  const client = new Anthropic({
    apiKey: "unused",
    maxRetries: 0,
    fetch: () => {
      throw new Error("Claude must not be called");
    },
  });
  const grantCalls: string[] = [];
  const grantFetch: typeof globalThis.fetch = async (input, init) => {
    grantCalls.push(
      `${init?.method} ${String(input)} ${new Headers(init?.headers).get("authorization")}`,
    );
    return new Response(JSON.stringify({ access_token: "jwt.test", expires_in: 60 }), {
      status: 200,
    });
  };

  const without = createApp(
    createHandlersFromConfig(loadConfig({}), { anthropicClient: client, fetch: grantFetch }),
    { corsOrigin: ORIGIN },
  );
  expect(await (await without.request("/api/providers")).json()).toEqual({ tokenIssuers: [] });
  expect((await without.request("/api/token/deepgram", { method: "POST" })).status).toBe(404);

  const config = loadConfig({ DEEPGRAM_API_KEY: "dg-key" });
  expect(config.deepgramApiKey).toBe("dg-key");
  const withKey = createApp(
    createHandlersFromConfig(config, { anthropicClient: client, fetch: grantFetch }),
    { corsOrigin: ORIGIN },
  );
  expect(await (await withKey.request("/api/providers")).json()).toEqual({
    tokenIssuers: ["deepgram"],
  });
  const token = await withKey.request("/api/token/deepgram", { method: "POST" });
  expect(token.status).toBe(200);
  expect(await token.json()).toMatchObject({ token: "jwt.test" });
  expect(grantCalls).toEqual(["POST https://api.deepgram.com/v1/auth/grant Token dg-key"]);
});

it("treats blank template values as unset", () => {
  // Copying .env.example verbatim leaves every optional variable as an empty string.
  const config = loadConfig({
    VOICE_CHAT_MODEL: "",
    VOICE_CHAT_EFFORT: "",
    VOICE_CHAT_MAX_TOKENS: "",
    VOICE_CHAT_SYSTEM_PROMPT: "",
    HOST: "",
    PORT: "",
    CORS_ORIGIN: "",
  });
  expect(config.system).toBe(DEFAULT_SYSTEM_PROMPT);
  expect(config.anthropic).toEqual({});
  expect(config).toMatchObject({
    host: "127.0.0.1",
    port: 3000,
    corsOrigin: "http://localhost:5173",
  });
});
