# voice-chat-kit

Voice chat with Claude, with switchable speech-to-text and text-to-speech providers.
Hold a button, speak, see the live transcript, hear Claude's streamed reply — and swap the
STT/TTS vendor by configuration instead of rewriting code.

**Status: Phase 0 (repository scaffold).** Nothing works end to end yet. The design and the
phase plan live in [`docs/plan.md`](docs/plan.md); the vendor research behind it is in
[`docs/research-2026-10-15.md`](docs/research-2026-10-15.md).

## Packages

| Package | Purpose |
|---|---|
| `@voice-chat-kit/core` | Provider-agnostic interfaces, session state machine, sentence chunker (Phase 1) |
| `@voice-chat-kit/providers` | STT/TTS adapters as subpath exports: `./stt`, `./tts` (Phases 2–3) |
| `@voice-chat-kit/react` | `useVoiceChat` and friends (Phases 2–3) |
| `@voice-chat-kit/server` | Web-standard `Request -> Response` handlers: Claude SSE chat, token minting (Phase 1) |
| `apps/web` | Vite + React demo |
| `apps/server` | Hono server mounting the handlers |

## Develop

Requires Node 24 LTS and pnpm 12 (`corepack enable` fetches the pinned pnpm).

```
pnpm install
pnpm check        # typecheck + lint + test + build
```

See [`AGENTS.md`](AGENTS.md) for the full list of commands and conventions.

## License

MIT — see [LICENSE](LICENSE).
