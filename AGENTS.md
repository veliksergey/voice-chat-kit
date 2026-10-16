# voice-chat-kit — repository facts for agents and developers

Invariants shared across all repositories live in the user's global `AGENTS.md`; this file holds
only what is specific to this repository.

## What this is

A pnpm monorepo for voice chat with Claude where speech-to-text (STT) and text-to-speech (TTS)
providers are swapped by configuration. Design, decisions, phases, and acceptance criteria:
`docs/plan.md`. Vendor research with dated sources: `docs/research-2026-10-15.md`.

Current phase: **1 — core + text chat**. Typed text streams a Claude reply end to end; the
`providers` package is still a placeholder (speech arrives in Phases 2–3).

## Layout

```
apps/web            @voice-chat-kit/web-demo     Vite 8 + React 19 demo (private); /api proxied to :3000
apps/server         @voice-chat-kit/server-demo  Hono app on @hono/node-server (private); config.ts reads env
packages/core       @voice-chat-kit/core         types, session machine, chunker, SSE parser, history window (publishable)
packages/providers  @voice-chat-kit/providers    subpath exports ./stt and ./tts (publishable, placeholder)
packages/react      @voice-chat-kit/react        useVoiceChat (publishable)
packages/server     @voice-chat-kit/server       createVoiceChatHandlers: validate, Claude stream, tokens (publishable)
docs/               plan, research, reviews/decisions.md
```

## Chat contract (Phase 1)

- `POST /api/chat` body `{ messages: [{ role: "user" | "assistant", content }] }`, validated by
  Zod in `packages/server/src/validate.ts` (limits in `DEFAULT_LIMITS`); `400` with a reason.
  `Content-Type` must be `application/json` (`415` otherwise) and `apps/server` rejects any
  `Origin` other than `CORS_ORIGIN` with `403` before dispatch: CORS headers alone do not stop a
  cross-site "simple" POST from reaching a billable endpoint.
- On a `400` the client retries once with the oldest half of the turns dropped
  (`dropOldestTurns` in core), then surfaces the error; `newConversation()` clears the transcript.
- Response is `text/event-stream` with events `text`, `fallback`, `done`, `refusal`, `error`;
  the typed shape is `ChatEvent` in `packages/core/src/types.ts`, encoded by
  `packages/server/src/sse.ts` and decoded by `parseChatEvent` in core.
- The client sends `buildHistoryWindow(...)` (core), never the full transcript; the server
  supplies `system`, `model`, `effort`, `max_tokens` from its own config only.
- A terminal refusal removes the refused turn (user + partial reply) from replay history; a
  fallback-rescued decline continues the same stream.

## Toolchain

- Node 24 LTS (`.node-version`); the build tool tsdown requires `^22.18 || ^24.11 || >=26`.
  Published packages declare `engines.node >=22.18`.
- pnpm 12, pinned in `package.json` (`packageManager`); `corepack enable` fetches it.
- TypeScript 7, strict ESM, `isolatedDeclarations` (every exported symbol has an explicit type).
- tsdown builds the publishable packages (ESM + `.d.ts`); Vite builds `apps/web`.
- Biome 2 for lint and format; Vitest 5 for tests (root `vitest.config.ts`).

## Commands (run from the repository root)

| Command | What it does | Must pass before review |
|---|---|---|
| `pnpm install` | install, links workspace packages | — |
| `pnpm typecheck` | `tsc --noEmit` in every package | yes |
| `pnpm lint` | `biome check .` | yes |
| `pnpm test` | `vitest run` across apps and packages | yes |
| `pnpm build` | tsdown / Vite builds into each `dist/` | yes |
| `pnpm check` | all four in order | yes |
| `pnpm format` | `biome format --write .` | — |
| `pnpm dev` | apps/server (tsdown watch + node) and Vite, in parallel | — |
| `LIVE_TESTS=1 pnpm test` | adds one real Claude turn; needs credentials; skipped whenever `CI` is set | — |

There is no CI workflow yet (planned for Phase 4); the checks above are the gate.

## Conventions

- **Workspace resolution without build order.** Each publishable package's `exports` points at
  `src/*.ts` for development; `publishConfig.exports` points at `dist/*` and pnpm substitutes it
  on publish. Typecheck and tests therefore never depend on a prior build.
- `apps/server` bundles the workspace packages (`noExternal`) so `node dist/index.js` runs
  without resolving `src` exports through symlinks.
- No vendor SDKs or API calls in Phase 0. From Phase 1 on, vendor keys live only in `apps/server`
  env (`.env`, git-ignored; template in `.env.example`) and never reach the browser.
- Tests are plain Vitest with explicit imports (no globals). Smoke tests avoid JSX.
- Each library package has a local smoke test; the public `exports` contract is verified from
  the consuming apps (`apps/web` for core, providers, react; `apps/server` for server), because
  a package cannot resolve its own name through pnpm's workspace links.
- Vitest's `fsModuleCache` is disabled in `vitest.config.ts`: it caches transformed test files
  with import paths already resolved, keyed on file content, so an edited `exports` map would
  not be re-checked by an unchanged test. Keep it off unless a cache key covers package.json.
- Comments explain non-obvious lines only; design rationale goes in `docs/plan.md`.

## Branch policy

`main` is the integration branch. Claude Code never commits; the user commits after each phase
has passed the checks and the Codex review loop. Feature branches are optional for solo work.

## Review bookkeeping

`docs/reviews/decisions.md` records review findings that were rejected with evidence, so they are
not raised again. Review logs and task files live outside the repository under
`~/.claude/codex-reviews/voice-chat-kit/`.

## Environment variables

`.env` lives at the repository root (template: `.env.example`); `apps/server` loads it from its
own directory or two levels up. Variables: `ANTHROPIC_API_KEY` (or an `ant auth login`
profile), `VOICE_CHAT_MODEL`, `VOICE_CHAT_EFFORT`, `VOICE_CHAT_MAX_TOKENS`,
`VOICE_CHAT_SYSTEM_PROMPT`, `DEEPGRAM_API_KEY` (Phase 2+), `HOST` (default `127.0.0.1`:
`/api/chat` spends Claude credits and v1 has no auth, so the server binds loopback unless told
otherwise), `PORT`, `CORS_ORIGIN`. Blank values in `.env` count as unset. The `VOICE_CHAT_`
prefix is deliberate: Claude Code exports `CLAUDE_EFFORT` into every shell it runs, so
`CLAUDE_*` names would be overridden silently.
