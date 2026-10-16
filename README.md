# voice-chat-kit

Voice chat with Claude, with switchable speech-to-text and text-to-speech providers.
Hold a button, speak, see the live transcript, hear Claude's streamed reply — and swap the
STT/TTS vendor by configuration instead of rewriting code.

**Status: Phase 2 (speech in).** Hold a button (or Space), speak, watch the live transcript,
and Claude's reply streams back as text. Two speech-to-text providers are switchable in the UI:
the free Web Speech API and Deepgram Nova-3. Spoken replies arrive in Phase 3. The design and
the phase plan live in [`docs/plan.md`](docs/plan.md); the vendor research behind it is in
[`docs/research-2026-10-15.md`](docs/research-2026-10-15.md).

## Packages

| Package | Purpose |
|---|---|
| `@voice-chat-kit/core` | Provider interfaces, session state machine, sentence chunker, SSE parser, history window |
| `@voice-chat-kit/providers` | STT/TTS adapters as subpath exports: `./stt`, `./tts` (Phases 2–3) |
| `@voice-chat-kit/react` | `useVoiceChat` — text path today, speech in Phases 2–3 |
| `@voice-chat-kit/server` | Web-standard `Request -> Response` handlers: validated Claude SSE chat, token minting |
| `apps/web` | Vite + React demo |
| `apps/server` | Hono server mounting the handlers |

## Run the demo

Requires Node 24 LTS and pnpm 12 (`corepack enable` fetches the pinned pnpm).

```
pnpm install
cp .env.example .env     # set ANTHROPIC_API_KEY (or sign in with `ant auth login`)
pnpm dev                 # apps/server on :3000, Vite on :5173 (proxies /api)
```

Open http://localhost:5173. Hold **Hold to talk** (or hold Space) and speak; release to send.
Or type a message. `Stop` aborts a turn; `New conversation` clears the transcript.

Speech-to-text providers:

| Provider | Needs | Notes |
|---|---|---|
| Web Speech API | nothing | Chrome, Edge, Safari. Chrome sends the audio to Google's servers; Firefox ships it disabled |
| Deepgram Nova-3 | `DEEPGRAM_API_KEY` in `.env` | The browser streams audio straight to Deepgram with a 60-second token minted by the server; your key never reaches the page |

```
pnpm check        # typecheck + lint + test + build
LIVE_TESTS=1 pnpm test   # also runs one real Claude turn (needs credentials)
```

See [`AGENTS.md`](AGENTS.md) for the full list of commands and conventions.

## License

MIT — see [LICENSE](LICENSE).
