# voice-chat-kit — repository facts for agents and developers

Invariants shared across all repositories live in the user's global `AGENTS.md`; this file holds
only what is specific to this repository.

## What this is

A pnpm monorepo for voice chat with Claude where speech-to-text (STT) and text-to-speech (TTS)
providers are swapped by configuration. Design, decisions, phases, and acceptance criteria:
`docs/plan.md`. Vendor research with dated sources: `docs/research-2026-10-15.md`.

Current phase: **0 — scaffold**. Packages export placeholders only; see the plan for what each
later phase adds.

## Layout

```
apps/web            @voice-chat-kit/web-demo     Vite 8 + React 19 demo (private)
apps/server         @voice-chat-kit/server-demo  Hono app on @hono/node-server (private)
packages/core       @voice-chat-kit/core         interfaces, state machine, chunker (publishable)
packages/providers  @voice-chat-kit/providers    subpath exports ./stt and ./tts (publishable)
packages/react      @voice-chat-kit/react        React hooks (publishable)
packages/server     @voice-chat-kit/server       Request -> Response handlers (publishable)
docs/               plan, research, reviews/decisions.md
```

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

See `.env.example`: `ANTHROPIC_API_KEY` (Phase 1+), `DEEPGRAM_API_KEY` (Phase 2+), `PORT`,
`CORS_ORIGIN`.
