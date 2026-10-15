# Project plan: voice chat with Claude, switchable STT/TTS providers

Status: draft for review (2026-10-15). Research behind every vendor claim is in
[research-2026-10-15.md](research-2026-10-15.md); items that could not be confirmed from a
primary source are marked **[unverified]** there and here.

## 1. Executive summary

Build a small, developer-friendly voice chat on the Claude API: hold a button, speak, see the
live transcript, get Claude's reply streamed back as text and as speech. Speech-to-text (STT)
and text-to-speech (TTS) are pluggable so a developer switches providers by configuration, not
by rewriting code. Delivered as a pnpm monorepo: publishable packages plus a demo app.

Why an adapter package rather than an existing framework: Claude has no audio input (every
request is text); no existing npm package covers streaming STT + browser-direct short-lived
tokens across the major vendors; and the hosted voice-agent platforms (Vapi, Retell, ElevenLabs
Agents, Deepgram Voice Agent) only offer their own STT/TTS vendor lists, so they cannot meet the
request to switch between arbitrary libraries, including free in-browser ones. They do let you
pick a Claude model (Vapi documents `model.provider` / `model.model`, checked 2026-10-15), but
their docs do not describe request-level controls such as cache breakpoints, effort, or
fallbacks; treat that as **[unverified per platform]**, not as a proven limitation. The adapter
layer is roughly 200 lines of interfaces; the value is in the demo, the docs, and the tested
provider implementations.

v1 scope (agreed with the user on 2026-10-15):

| Area | v1 | Later phases |
|---|---|---|
| Voice path | STT + Claude + TTS (full loop) | — |
| Interaction | Push-to-talk with live interim transcript | Hands-free VAD + barge-in |
| STT providers | Web Speech API (free), Deepgram Nova-3 (paid) | OpenAI `gpt-transcribe` / Vercel AI SDK batch adapter (~15 vendors), Transformers.js Whisper (on-device), AssemblyAI, sherpa-onnx |
| TTS providers | Web Speech `speechSynthesis` (free), Deepgram Aura-2 (paid) | ElevenLabs, Cartesia, kokoro-js |
| Persistence | None (client holds history) | MongoDB `ConversationStore` |
| Auth | None (local dev) | Required before any public deployment |

## 2. Decisions

| # | Decision | Reason | Source |
|---|---|---|---|
| D1 | Full voice chat (STT + TTS) in v1 | User choice | User, 2026-10-15 |
| D2 | Push-to-talk with live transcript; batch-only providers fall back to record-then-transcribe | User choice; avoids VAD/echo complexity while still feeling live | User |
| D3 | pnpm monorepo: publishable packages + demo app | User choice; "simple for developers to use it, maybe create a package" | User |
| D4 | STT v1 = Web Speech API + Deepgram Nova-3 | User choice. Web Speech: zero setup, free, streaming interims. Deepgram: low-cost paid streaming ($0.0048/min, about $0.29/hr; AssemblyAI's `universal-streaming` is cheaper at $0.15/hr and is the phase-2 candidate), $200 free credit, mature SDK v5, browser connects directly with a short-lived JWT | User; research §1a |
| D5 | TTS v1 = Web Speech `speechSynthesis` + Deepgram Aura-2 | Mirrors D4: one free, one paid. Aura-2 reuses the Deepgram key, credit, and `/v1/auth/grant` token flow, so the paid path needs one vendor account. ElevenLabs (most popular) and Cartesia (best free tier) are phase 2 | Claude recommendation, **open for user override** |
| D6 | Claude via `@anthropic-ai/sdk` (0.134), model `claude-opus-5-5`, streaming, `output_config.effort: "low"` by default, system prompt cached with `cache_control`, server-side refusal fallbacks (`fallbacks: "default"`) enabled by default | Skill defaults; low effort for conversational latency; fallbacks keep the chat going when a safety classifier declines. Model and effort configurable via env | `claude-api` skill, 2026-10-06 cache |
| D7 | Backend = Hono 4.13 on `@hono/node-server`; package handlers are Web-standard `Request -> Response` so they also mount in Express/Fastify/Bun | Built-in SSE + WebSocket helpers, TypeScript-first; handlers stay framework-agnostic for package users | Research §C |
| D8 | No database in v1. Client sends full message history each turn; server is stateless. `ConversationStore` interface defined in core for the Mongo phase | Smallest cohesive v1; the Claude API is stateless anyway | — |
| D9 | Tooling: Node 24 LTS for development and CI (tsdown 0.23 builds only on `^22.18.0 \|\| ^24.11.0 \|\| >=26.0.0`, checked 2026-10-15; the published packages declare `engines.node: ">=22.18"`), pnpm 12 pinned via `packageManager`, TypeScript 7 (fallback 6.x if a tool lags), Vite 8, React 19, Biome 2, Vitest 5, tsdown for library builds | Current stable versions; tsup is officially unmaintained | Research §C; tsdown.dev/guide/getting-started |
| D10 | API keys live only on the server. Browser-direct providers (Deepgram) get a short-lived token minted by the server; everything else is proxied | Security invariant: never ship vendor keys to the client | AGENTS.md invariants |
| D11 | Package scope placeholder `@scope/voice-chat-*` until the user names one; license MIT assumed | Unknown | **Open question** |

## 3. Target developer experience

This is the bar the packages must meet. Server side (any Web-standard framework; Hono shown):

```ts
import { Hono } from "hono";
import { createVoiceChatHandlers, deepgramTokenIssuer } from "@scope/voice-chat-server";

const voice = createVoiceChatHandlers({
  anthropic: { apiKey: process.env.ANTHROPIC_API_KEY!, model: "claude-opus-5-5" },
  system: "You are a concise voice assistant. Answer in one or two spoken sentences.",
  // Browser-direct vendors register a token issuer; the vendor key never leaves the server.
  tokenIssuers: {
    deepgram: deepgramTokenIssuer({ apiKey: process.env.DEEPGRAM_API_KEY!, ttlSeconds: 60 }),
  },
});

const app = new Hono();
app.post("/api/chat", (c) => voice.chat(c.req.raw));          // SSE stream of text deltas
app.post("/api/token/:provider", (c) => voice.token(c.req.raw)); // short-lived provider token
app.get("/api/providers", (c) => voice.providers(c.req.raw));    // which providers are configured
```

Client side:

```tsx
import { useVoiceChat } from "@scope/voice-chat-react";
import { deepgramStt, webSpeechStt } from "@scope/voice-chat-providers/stt";
import { deepgramTts, webSpeechTts } from "@scope/voice-chat-providers/tts";

const chat = useVoiceChat({
  baseUrl: "/api",
  stt: deepgramStt(),   // or webSpeechStt()
  tts: webSpeechTts(),  // or deepgramTts({ voice: "aura-2-thalia-en" })
});

<button onPointerDown={chat.startListening} onPointerUp={chat.stopListening}>
  {chat.state === "listening" ? "Listening..." : "Hold to talk"}
</button>
<p>{chat.interimTranscript}</p>
<ul>{chat.messages.map((m) => <li key={m.id}>{m.role}: {m.text}</li>)}</ul>
<button onClick={chat.stop}>Stop</button>
```

Adding a provider has at most two halves, and neither touches core or existing providers:

1. Client half (always): implement `SttProvider` or `TtsProvider` (section 5) and pass it to
   the hook. Providers that need no server (Web Speech, on-device models) stop here.
2. Server half (only for vendors that authenticate the browser with a short-lived token):
   implement `TokenIssuer` (`{ id: string; issue(): Promise<{ token: string; expiresAt: number }> }`)
   and register it under `tokenIssuers`. `POST /api/token/:provider` dispatches by id and returns
   404 for an unregistered id; `GET /api/providers` returns the registered ids so the UI offers
   only configured providers. The hook's default `getToken` calls `/api/token/<provider.id>`; a
   provider may pass its own `getToken` to use a different endpoint.

Vendors with no browser token flow (for example Groq) need a server-side proxy route instead;
that contract is defined in phase 2 when the first such adapter is built, and is a known gap in
v1. The docs will include a worked example that adds AssemblyAI: a client adapter of about 60
lines plus a token issuer of about 15 lines.

## 4. Architecture

```
Browser (apps/web, React)                           Server (apps/server, Hono)
┌─────────────────────────────────────┐             ┌────────────────────────────────────┐
│ useVoiceChat()  [packages/react]    │             │ POST /api/token/deepgram            │
│  ├─ mic capture (MediaRecorder)     │             │    -> Deepgram /v1/auth/grant        │
│  ├─ SttProvider                     │             │    -> { token, expiresAt } (TTL 60 s)│
│  │    web-speech: in-browser        │             │                                    │
│  │    deepgram: audio ──WS──────────┼──(direct)──>│ Deepgram /v1/listen (not via server)│
│  ├─ final transcript ──POST /api/chat─────────────>│ POST /api/chat                      │
│  ├─ text deltas <──SSE────────────────────────────┤    @anthropic-ai/sdk messages.stream │
│  ├─ sentence chunker                │             │    -> SSE: text | done | refusal | error
│  └─ TtsProvider                     │             │                                    │
│       web-speech: speechSynthesis   │             │ GET /api/providers, GET /healthz    │
│       deepgram: text ──WS──> Aura-2 ─┼──(direct)──>│ Deepgram /v1/speak (not via server) │
│         PCM16 -> AudioContext queue │             └────────────────────────────────────┘
└─────────────────────────────────────┘
```

Data flow for one turn:

1. User presses the button. The hook requests the mic, starts the STT session (for Deepgram it
   first fetches a token from the server), and moves to `listening`.
2. Interim transcripts render live. On release the session stops and resolves the final text.
3. The hook appends the user message and `POST`s a bounded window of the history to
   `/api/chat`. The window is built deterministically so it always satisfies the server limits
   in section 8, without assuming anything about how many characters a token can hold:
   1. Per-message cap: a message longer than 8,000 characters is sent truncated to 8,000 with a
      trailing `…` marker; the full text stays in the UI transcript. This covers long
      transcripts and long replies alike. `max_tokens` bounds tokens, not characters, so it is
      not relied on for size.
   2. Count cap: while the window holds more than 20 messages, drop the oldest 10 at once, not
      one per turn, so the cached prefix stays stable for the next 10 turns.
   3. Byte cap: while the JSON body exceeds 48 KB, drop the oldest *turn*, where a turn is one
      `user` message plus the `assistant` message that follows it, if any. Eviction is defined
      per turn, not per pair, so it still makes progress when the history holds consecutive
      `user` messages. The newest `user` message is never dropped; after step 1 it is at most
      32,000 bytes (8,000 characters × 4 bytes UTF-8), so it always fits on its own.
   4. The window must begin with a `user` message; a leading `assistant` message is dropped.

   The client caps (8,000 characters / 20 messages / 48 KB) sit below the server caps (16,000
   characters / 50 messages / 64 KB), so a `400` in normal use indicates a client/server version
   mismatch rather than a conversation that has grown too long; the hook retries once after
   dropping the oldest half of the turns, then surfaces the error with a "New conversation"
   action. Server-side compaction replaces the window in the Mongo phase.
4. The server streams Claude's reply as SSE text deltas. The hook appends deltas to the
   assistant message and feeds them to a sentence chunker.
5. Each complete sentence goes to the TTS provider so audio starts before Claude finishes.
   Deepgram Aura-2 returns PCM16 over WebSocket; chunks are queued on an `AudioContext`.
   Web Speech uses `speechSynthesis.speak()` per sentence.
6. `stop()` or a new button press aborts the fetch (`AbortController`), closes the TTS socket,
   clears the audio queue, and cancels `speechSynthesis`.
7. An SSE `refusal` event runs the same cancellation and additionally removes the refused turn
   (the user message that triggered it and the partial assistant reply) from the replay
   history, so a refused request is never re-sent and no unmatched `user` messages accumulate;
   the UI transcript keeps both, with the refusal notice (section 5, Refusals). An `error`
   event cancels TTS and keeps the history as it was before the turn.

Session state machine (in core, unit-tested): `idle -> listening -> transcribing -> thinking ->
speaking -> idle`, with `cancel` allowed from any state and `error` as a terminal-then-idle state.

## 5. Package layout and interfaces

```
text-to-voice-to-claude/
├─ apps/
│  ├─ web/          Vite 8 + React 19 demo: provider switchers, PTT button, transcript, chat log
│  └─ server/       Hono app mounting the package handlers; .env.example
├─ packages/
│  ├─ core/         @scope/voice-chat-core      interfaces, state machine, sentence chunker, SSE client; no vendor deps
│  ├─ providers/    @scope/voice-chat-providers subpath exports: ./stt, ./tts (web-speech, deepgram); @deepgram/sdk is an optional peer dep
│  ├─ react/        @scope/voice-chat-react     useVoiceChat, useStt, useTts
│  └─ server/       @scope/voice-chat-server    createVoiceChatHandlers (Request -> Response), Claude client wrapper, token minting
├─ docs/            plan, research, reviews/decisions.md, "add a provider" guide
├─ AGENTS.md        repo facts and the check commands
├─ pnpm-workspace.yaml  package.json  tsconfig.base.json  biome.json  .env.example
```

Core interfaces (sketch; final shapes are decided during Phase 1 and recorded in the task file):

```ts
export interface SttCapabilities { streaming: boolean; interimResults: boolean; runsInBrowser: boolean; needsToken: boolean }
export interface SttProvider {
  readonly id: string;                     // "web-speech" | "deepgram" | ...
  readonly capabilities: SttCapabilities;
  start(opts: {
    language?: string;
    getToken?: () => Promise<{ token: string; expiresAt: number }>;
    onPartial: (text: string) => void;
    onFinal: (text: string) => void;
    onError: (err: Error) => void;
    signal: AbortSignal;
  }): Promise<SttSession>;
}
export interface SttSession { stop(): Promise<string> /* final transcript */ }

export interface TtsCapabilities { streamingInput: boolean; runsInBrowser: boolean; needsToken: boolean }
export interface TtsProvider {
  readonly id: string;
  readonly capabilities: TtsCapabilities;
  speak(sentences: AsyncIterable<string>, opts: {
    voice?: string;
    getToken?: () => Promise<{ token: string; expiresAt: number }>;
    signal: AbortSignal;
    onStart?: () => void;
    onEnd?: () => void;
  }): Promise<void>;
}

export interface ConversationStore {   // defined now, implemented in the Mongo phase
  load(conversationId: string): Promise<Anthropic.MessageParam[]>;
  append(conversationId: string, message: Anthropic.MessageParam): Promise<void>;
}
```

Server contract:

| Endpoint | Request | Response |
|---|---|---|
| `POST /api/chat` | `{ messages: MessageParam[], conversationId? }` — validated against the schema in section 8 before any Anthropic call; `400` on violation | SSE events: `text` `{delta}`, `done` `{stopReason, usage}`, `refusal` `{category, explanation}`, `error` `{message}` |
| `POST /api/token/:provider` | none | `{ token, expiresAt }` from the registered `TokenIssuer` (Deepgram: `/v1/auth/grant`, TTL 60 s); `404` for an unregistered provider |
| `GET /api/providers` | none | `{ tokenIssuers: ["deepgram"] }` — the client marks a `needsToken` provider available only if its id is listed; browser-only providers check their own browser support |
| `GET /healthz` | none | `200 ok` |

Claude call (server): `client.beta.messages.stream({ model, max_tokens: 4096, cache_control: { type: "ephemeral" }, system, messages, output_config: { effort }, betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" })` (every parameter name is to be confirmed against the SDK types in Phase 1), where `messages` is the validated client history (section 8) and `system`, `model`, `effort`, and `max_tokens` come only from server configuration. `max_tokens` is deliberately low because spoken replies must be short; the system prompt asks for one or two sentences.

Prompt caching (prompt-caching docs, checked 2026-10-15; quotes in research §0b): Opus 5.5
caches only prefixes of at least 512 tokens; shorter prompts "will be processed without caching,
and no error is returned". The one-sentence demo system prompt is far below that, so a
system-prompt breakpoint alone caches nothing. The server therefore uses top-level automatic
caching (`cache_control` on the request), where "the cache breakpoint automatically moves to the
last cacheable block in each request", so the growing conversation prefix is cached once it
passes 512 tokens; each turn adds two blocks, well under the 20-block lookback limit. Evicting
messages from the client window (section 4) costs one cache miss, after which the prefix is
stable again. Short demo chats get no cache benefit; the live smoke test asserts
`cache_read_input_tokens > 0` on the third turn of a conversation longer than 512 tokens.

Refusals: `stop_reason: "refusal"` is forwarded as an SSE `refusal` event, never swallowed. Two
cases, per the refusals documentation (checked 2026-10-15):

- A decline rescued by the server-side fallback continues on the same stream and "continues from
  the partial output": the client just keeps receiving `text` deltas (the server may add a
  `fallback` event for display).
- A terminal refusal (no fallback, or the fallback also declined) can arrive after partial text
  was streamed; that partial output "is incomplete" and must be discarded. The server stops
  sending deltas and emits `refusal`; the hook aborts TTS (clears the sentence queue, closes the
  Aura-2 socket, calls `speechSynthesis.cancel()`), removes the refused turn (the user message
  and the partial assistant message) from the replay history so neither is re-sent, and renders
  the refusal notice. Audio already played cannot be retracted; this is accepted and documented.

## 6. Phases, milestones, estimates

Estimates are rough, for one developer, and assume the user has Anthropic and Deepgram keys.

| Phase | Work | Done when | Est. |
|---|---|---|---|
| 0 Scaffold | Prerequisite: install Node 24 LTS and pnpm 12 (`corepack enable` or `pnpm self-update`); the local Node 22.14 is below tsdown's build range. Then: pnpm workspace, tsconfig base, Biome, Vitest, tsdown configs, `engines` + `packageManager` fields, `AGENTS.md` with check commands, `.env.example`, `docs/reviews/decisions.md` | `pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass on an empty skeleton under Node 24 | 0.5 d |
| 1 Core + text chat | `core` types, state machine, sentence chunker, SSE parser (all unit-tested); `server` chat handler with Claude streaming + fallbacks; `apps/server`; `apps/web` text-only chat | Typed text -> streamed Claude reply in the browser; refusal and error events rendered | 1 d |
| 2 STT | `web-speech` adapter; `deepgram` adapter (MediaRecorder -> WS); token endpoint; `useStt`; PTT UI with interim transcript | Speak -> live transcript -> reply, with either provider, switchable in the UI | 1–1.5 d |
| 3 TTS | `web-speech` synth adapter; `deepgram` Aura-2 WS adapter with PCM16 `AudioContext` queue; `useTts`; cancel/barge on button press | Full loop in Chrome with both providers; Stop cancels within ~200 ms | 1 d |
| 4 Docs + publish-ready | READMEs, "add a provider" guide, capability matrix, `pnpm -r publish --dry-run`, changesets, CI workflow file | A new developer follows the README to a working demo without asking questions | 0.5–1 d |

Phase 1 is a real checkpoint: it proves the Claude path and the monorepo wiring before any audio
work starts. Each phase goes through the Codex review loop before the next begins.

## 7. Testing strategy

- Unit (Vitest, all packages): state-machine transitions incl. cancel from every state;
  history window (a 30-turn conversation keeps sending valid requests; the window always starts
  at a `user` message; the oldest 10 are dropped together; a 20,000-character assistant reply
  is truncated to 8,000 characters in the request while the UI keeps the full text, and the
  next request passes validation; byte overflow uses a multibyte fixture — three 8,000-character
  CJK messages of about 24,000 bytes each, so the body is about 72 KB *after* per-message
  truncation — and asserts that eviction runs, the newest `user` message survives, and the
  request passes; two consecutive terminal refusals followed by a normal turn leave no refused
  user message in the replay history and the normal turn succeeds; a `400` triggers one retry
  with half the turns dropped and then the error state); sentence chunker (abbreviations,
  numbers, streaming boundaries); SSE parser; token handler
  with mocked `fetch`; Deepgram adapters against a mocked `WebSocket` using message shapes
  from the Deepgram docs; Web Speech adapters against a stubbed `SpeechRecognition` /
  `speechSynthesis`.
- Integration: `/api/chat` with the Anthropic SDK's `fetch` overridden to replay recorded
  streams; asserts SSE event order, abort propagation, every history-validation rule (one
  negative case each, including a `role: "system"` message and an oversized body), and a
  recorded stream that emits text and then ends in `refusal`: the `refusal` event is emitted,
  the hook clears the TTS queue, and the refused turn (its user message and the partial
  assistant message) is absent from the next request's history.
- Live smoke (opt-in, `LIVE_TESTS=1` + keys): one real Claude turn, one real Deepgram token
  grant. Never runs in CI by default.
- Browser: deferred to phase 4 as optional Playwright smoke (load demo, providers list
  renders). Mic/audio hardware tests stay manual with a checklist in the README.
- Checks documented in `AGENTS.md`: `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`.

## 8. Security and privacy

- Vendor keys only in server env; `.env` is git-ignored; `.env.example` lists every variable.
- Deepgram tokens: minted per session with TTL 60 s, CORS-restricted to the demo origin, with
  a small in-memory rate limit on the token endpoint. **v1 has no user authentication**, so
  anyone who can reach the server can mint tokens and call Claude on your keys: bind to
  localhost for development and document that production requires auth before exposure.
- Client-supplied history is validated by a Zod schema in `packages/server` before any Anthropic
  call: roles `user` and `assistant` only (`system` is rejected: Opus 5.5 accepts mid-conversation
  `role: "system"` messages as operator instructions with no beta header, so forwarding them
  would hand operator authority to any caller); content is a string or `text` blocks only (no
  image, document, or tool blocks); at most 50 messages, 16,000 characters per message, 64 KB
  body; first and last message must be `user`. Violations return `400` and are covered by
  negative tests, one per rule. These limits are a backstop against direct callers: the client
  window (section 4, step 3) truncates and evicts deterministically below them (8,000
  characters / 20 messages / 48 KB), so normal conversations never reach them, and nothing
  assumes a relationship between `max_tokens` and character length. The Mongo phase moves history server-side and keys it by an
  authenticated user; the schema stays as defense in depth.
- Web Speech API in Chrome sends audio to Google's servers (MDN); the UI shows a note. On-device
  recognition (`processLocally`, Chrome/Edge 139+) is experimental and not relied on.
- `getUserMedia` requires HTTPS except on `localhost`; mobile Safari needs the `AudioContext`
  created inside the button's pointer event (autoplay policy).
- Transcripts and replies are not logged by default; a debug flag enables console logging.

## 9. Risks and mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Web Speech API support: off by default in Firefox; `webkit` prefix and continuous-mode quirks in Safari | Free path unavailable in some browsers | Capability detection hides unsupported providers; Deepgram works everywhere `MediaRecorder` does |
| Browser audio format for Deepgram: `MediaRecorder` yields webm/opus in Chrome/Firefox but mp4/aac in Safari; Deepgram's accepted containers must be confirmed at implementation time **[unverified for Safari]** | Safari STT may fail | Start with `MediaRecorder` (simplest); fall back to an `AudioWorklet` PCM16 path if Safari fails |
| Perceived latency (Claude first token + TTS first audio) | Feels slow | `effort: "low"`, sentence-level TTS streaming, short `max_tokens`, conversation-prefix caching (effective only once the conversation exceeds 512 tokens; the short system prompt alone does not cache) |
| TypeScript 7 (native compiler) is new; some tooling may lag | Build breaks | Pin 7.x; documented fallback to 6.x |
| Local toolchain is Node 22.14 / pnpm 11.17; Node 22.14 is outside tsdown's build range (`^22.18.0 \|\| ^24.11.0 \|\| >=26.0.0`) | Phase 0 cannot build until Node is upgraded | Upgrade to Node 24 LTS as the first Phase 0 step; `engines` + `packageManager` fields fail fast on the wrong versions; CI runs on Node 24 and smoke-loads the built packages on Node 22.18 |
| Deepgram grant-token scopes and whether one JWT serves both `/listen` and `/speak` | Token endpoint design | Verify against the docs during phase 2 (research says yes, with the token sent as a WebSocket subprotocol) |
| `fallbacks: "default"` is a beta parameter | Could change | Behind a config flag; default on per the Claude skill guidance |
| Package names/scope unknown | Rename churn | Placeholder scope; rename once before phase 4 |

## 10. Open questions for the user

1. npm scope and package names (placeholder `@scope/voice-chat-*`). Public or private registry?
2. TTS paid vendor: keep Deepgram Aura-2 (D5) or use ElevenLabs in v1?
3. License: MIT assumed.
4. Deploy target: local development only is assumed for v1.
5. Should the demo expose model/effort selection in the UI, or keep them server-side env only?

## 11. v1 acceptance criteria (testable)

1. `pnpm install && pnpm typecheck && pnpm lint && pnpm test && pnpm build` pass on Node 24 LTS; the built packages load and pass a smoke test on Node 22.18 (the declared `engines` floor).
2. With only `ANTHROPIC_API_KEY` set, the demo completes the full loop in Chrome using Web Speech STT and Web Speech TTS.
3. With `DEEPGRAM_API_KEY` also set, Deepgram appears in both selectors and the loop works with live interim transcript.
4. Switching STT or TTS provider requires no code change: selector or config only.
5. A new provider is added by implementing the interface and passing it to the hook; the docs show a working example under 100 lines.
6. No vendor API key is ever sent to the browser; the token endpoint returns only a short-lived token (asserted by a test and by inspecting network traffic).
7. Stop cancels the Claude stream and audio playback within ~200 ms (measured in a unit test for the state machine and manually in the demo).
8. Refusals and errors are rendered in the UI; a terminal refusal cancels speech and drops the refused turn from the replay history; the app never crashes on either.
10. `POST /api/chat` rejects a `role: "system"` message, non-text content, and oversized bodies with `400` before any Anthropic call (negative tests).
11. A conversation of 30 or more turns continues without error, and a reply longer than the per-message cap is truncated in the request (never in the UI) so the next turn succeeds (history-window tests, including the multibyte short-conversation byte-overflow case and consecutive refusals).
9. Every check command listed in `AGENTS.md` exists and is green before each Codex review round.

## 12. Out of scope for v1

Hands-free VAD and barge-in; MongoDB persistence; user authentication; publishing to npm (dry-run
only); OpenAI/AI-SDK batch adapter; Transformers.js on-device Whisper; ElevenLabs/Cartesia TTS;
telephony; mobile apps.
