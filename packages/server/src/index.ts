// Phase 0: only the health handler exists. The Claude chat stream and token issuers arrive in
// Phase 1 (docs/plan.md §5). Handlers are web-standard so any framework can mount them.
export const PACKAGE_NAME = "@voice-chat-kit/server";

/** Responds 200 "ok". apps/server mounts it at GET /healthz. */
export function healthHandler(_request: Request): Response {
  return new Response("ok", {
    status: 200,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}
