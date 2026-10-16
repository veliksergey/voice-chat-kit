import { describe, expect, it } from "vitest";
import { deepgramTokenIssuer } from "./deepgram.js";
import { createVoiceChatHandlers } from "./handlers.js";
import { mockAnthropic, sseOk } from "./test-support.js";

interface Captured {
  url: string;
  init: RequestInit | undefined;
}

function grantStub(respond: () => Response): { fetch: typeof globalThis.fetch; calls: Captured[] } {
  const calls: Captured[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return respond();
  };
  return { fetch, calls };
}

const KEY = "dg-secret-key-123";

describe("deepgramTokenIssuer", () => {
  it("requests a 60 s token with the API key in the Authorization header and maps the response", async () => {
    const stub = grantStub(
      () =>
        new Response(JSON.stringify({ access_token: "jwt.abc", expires_in: 60 }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const before = Date.now();
    const issuer = deepgramTokenIssuer({ apiKey: KEY, fetch: stub.fetch });
    const info = await issuer.issue();

    expect(issuer.id).toBe("deepgram");
    expect(stub.calls[0]?.url).toBe("https://api.deepgram.com/v1/auth/grant");
    expect(stub.calls[0]?.init?.method).toBe("POST");
    expect(new Headers(stub.calls[0]?.init?.headers).get("authorization")).toBe(`Token ${KEY}`);
    expect(JSON.parse(String(stub.calls[0]?.init?.body))).toEqual({ ttl_seconds: 60 });
    expect(info.token).toBe("jwt.abc");
    expect(info.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(info.expiresAt).toBeLessThanOrEqual(Date.now() + 60_000);
  });

  it("fails without leaking the key when the grant is rejected or malformed", async () => {
    const rejected = deepgramTokenIssuer({
      apiKey: KEY,
      fetch: grantStub(() => new Response(JSON.stringify({ err_msg: "nope" }), { status: 401 }))
        .fetch,
    });
    await expect(rejected.issue()).rejects.toThrow(/failed \(401\)/);
    await expect(rejected.issue()).rejects.not.toThrow(new RegExp(KEY));

    const malformed = deepgramTokenIssuer({
      apiKey: KEY,
      fetch: grantStub(() => new Response("{}", { status: 200 })).fetch,
    });
    await expect(malformed.issue()).rejects.toThrow(/no access_token/);
  });

  it("is served by the token handler and a failing grant becomes 502", async () => {
    let fail = false;
    const stub = grantStub(() =>
      fail
        ? new Response("boom", { status: 500 })
        : new Response(JSON.stringify({ access_token: "jwt.xyz", expires_in: 30 }), {
            status: 200,
          }),
    );
    const handlers = createVoiceChatHandlers({
      anthropic: { client: mockAnthropic(() => sseOk("")).client },
      system: "test",
      tokenIssuers: [deepgramTokenIssuer({ apiKey: KEY, fetch: stub.fetch, ttlSeconds: 30 })],
    });

    const ok = await handlers.token(
      new Request("http://localhost/api/token/deepgram", { method: "POST" }),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ token: "jwt.xyz" });

    fail = true;
    const bad = await handlers.token(
      new Request("http://localhost/api/token/deepgram", { method: "POST" }),
    );
    expect(bad.status).toBe(502);
    expect(JSON.stringify(await bad.json())).not.toContain(KEY);
  });
});
