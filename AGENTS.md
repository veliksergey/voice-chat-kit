# voice-chat-kit — repository facts for agents and developers

Invariants shared across all repositories live in the user's global `AGENTS.md`; this file holds
only what is specific to this repository.

## What this is

A pnpm monorepo for voice chat with Claude where speech-to-text (STT) and text-to-speech (TTS)
providers are swapped by configuration. Design, decisions, phases, and acceptance criteria:
`docs/plan.md`. Vendor research with dated sources: `docs/research-2026-10-15.md`.

Current phase: **3 — full voice loop**. Push-to-talk with Web Speech API or Deepgram Nova-3
streams a live transcript, Claude's reply streams as text and is spoken sentence by sentence by
Web Speech synthesis or Deepgram Aura-2; text input still works. Later phases: docs/publishing,
Mongo, more vendors.

## Layout

```
apps/web            @voice-chat-kit/web-demo     Vite 8 + React 19 demo (private); /api proxied to :3000
apps/server         @voice-chat-kit/server-demo  Hono app on @hono/node-server (private); config.ts reads env
packages/core       @voice-chat-kit/core         types, session machine, chunker, SSE parser, history window (publishable)
packages/providers  @voice-chat-kit/providers    ./stt: webSpeechStt, deepgramStt; ./tts: webSpeechTts, deepgramTts (publishable)
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

## Speech-to-text (Phase 2)

- Adapters implement `SttProvider` from core and live in `packages/providers/src/stt/`. Adding a
  vendor = a new adapter file + (for browser-token vendors) a `TokenIssuer` in `packages/server`.
- `webSpeechStt()`: browser `SpeechRecognition` (prefixed or not); free; `isSupported()` is false
  where the API is missing (Firefox by default). Chrome sends the audio to Google's servers — the
  demo says so next to the selector.
- `deepgramStt()`: the browser opens `wss://api.deepgram.com/v1/listen?model=nova-3&interim_results=true&smart_format=true`
  itself with a 60 s JWT minted by `POST /api/token/deepgram` (`deepgramTokenIssuer` →
  Deepgram `POST /v1/auth/grant`, `Authorization: Token <key>`; the key never leaves the server).
  The JWT travels only as the WebSocket subprotocol `["bearer", <jwt>]` — the form the official
  `@deepgram/sdk` 5.15 browser build uses (`protocols.push("bearer", token)`) — never in the URL.
  Audio is `MediaRecorder` output (webm/opus where supported) sent as binary frames with no
  `encoding`/`sample_rate` params: Deepgram's docs say to omit them for containerized audio.
  `stop()` sends `{"type":"CloseStream"}` and waits (bounded) for the final `Results`.
- No `@deepgram/sdk` dependency anywhere; both halves use the documented wire protocol.
- Hook flow (`useVoiceChat`): `startListening` (`idle -> listening`, token fetched first when
  `needsToken`), interim text in `interimTranscript`, `stopListening`
  (`listening -> transcribing -> thinking`) sends the final transcript through the same chat
  path as typed text; an empty transcript returns to `idle`; `stop()`/unmount abort the session.
- Demo keyboard rule (`apps/web/src/usePushToTalkKey.ts`): Space holds to talk only when focus is
  on the page or the PTT button (`data-ptt`), so other controls keep native Space; losing window
  focus or tab visibility while recording cancels via `stop()` instead of sending.
- Any Deepgram socket close before `stop()` — even a clean 1000 — is a failure (audio would be
  discarded silently otherwise); recorder `error` events and construction failures tear down too.
- Web Speech ends recognition by itself (silence timeouts); `webSpeechStt` restarts it while the
  session is held (never after a reported error) and accumulates finals across runs.
- Pointer hold-to-talk (`apps/web/src/usePointerHold.ts`): `pointerup`/`leave`/`cancel` act only on
  a press the pointer started, so they cannot end a Space-held recording.

## Text-to-speech (Phase 3)

- Adapters implement `TtsProvider` from core (`speak(sentences, { voice, getToken, signal,
  onStart, onEnd })`) and live in `packages/providers/src/tts/`. `GetToken` (STT and TTS) takes
  an optional `AbortSignal`; the hook passes it to the token `fetch`, and the Deepgram adapters
  race the token wait against abort so Stop works even while the token request is stalled. The hook feeds them a
  `SentenceStream` (core): reply deltas go through the `SentenceChunker` and complete sentences
  are spoken while the reply is still streaming; `end()` flushes the remainder, `cancel()` drops
  what has not been spoken.
- `webSpeechTts()`: one `SpeechSynthesisUtterance` per sentence via `speechSynthesis`; abort maps
  to `speechSynthesis.cancel()`; `interrupted`/`canceled` are cancellations, other errors reject.
  Chromium's `cancel()` fires no event for utterances that never started, so on abort the adapter
  settles completion itself instead of waiting for the browser.
- `deepgramTts()`: browser WebSocket to `wss://api.deepgram.com/v1/speak?model=<aura voice>&encoding=linear16&sample_rate=24000`
  with the same 60 s JWT as STT as the `["bearer", <jwt>]` subprotocol (Deepgram's token page
  lists the `/speak` WebSocket among the APIs that accept temporary tokens). Per sentence it sends
  `{"type":"Speak","text":…}` then `{"type":"Flush"}`; after the last sentence `{"type":"Close"}`.
  A sentence over 2,000 characters (Deepgram's documented payload cap) is split at a space into
  several `Speak` messages under that one `Flush`; the space stays with the preceding payload,
  because Deepgram appends payloads to one text buffer and a dropped separator would run two
  words together. Flushes are paced to Deepgram's limit of 20 per 60 s: past the budget the text
  still goes out and one deferred `Flush` (or `Close`) covers it when the oldest flush leaves the
  window; while a flush is deferred, the next sentence is sent with a leading space so the
  buffered sentences stay apart. Text is paced to Deepgram's throughput cap of
  2,400 characters per minute: a `Speak` part that would overflow the window waits (abortably)
  until enough of the oldest characters age out; playback runs slower than that, so the wait
  never starves the audio queue.
  Binary frames are raw linear16 PCM, converted to Float32 and scheduled gaplessly on an
  `AudioContext` created synchronously at `speak()` (still inside the user's gesture, before the
  token and handshake waits; resumed if the browser created it suspended). A buffer starts when
  the queued audio ends while that is still in the future; only the first buffer or an underrun
  gets a 20 ms lead. Resolves when every `Flush` has been acknowledged by a `Flushed`, Deepgram
  has closed the socket after `Close`, and the last buffer ended. A clean close with flushes
  still unacknowledged, no close within `closeTimeoutMs` (10 s), any earlier close, `Error`, or
  socket error rejects; abort stops every scheduled source and closes socket and context.
- Hook flow: `thinking -> speaking` on the provider's `onStart`, `speaking -> idle` when speech
  ends. `stop()` aborts speech and invalidates the in-flight turn, so a request whose body is
  still open when the user barges cannot cancel the next turn's speech or flip the new session's
  state when its abort error arrives later; a turn only ever cancels its own speech. `stop()`
  also finalises the interrupted reply at once (kept if it has text, dropped if empty) so a turn
  started right away replays what the user actually heard. A terminal
  `refusal` or `error` cancels queued speech; pressing to talk or sending text while speaking
  cancels speech first (barge by button); a TTS failure is a notice (`error` text) and never marks
  the text turn failed, including a provider whose `speak()` throws synchronously (the call stays
  synchronous so audio set-up remains inside the user's gesture).

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
