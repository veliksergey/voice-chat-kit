import { PACKAGE_NAME } from "@voice-chat-kit/core";

// Phase 0: proves the Vite + React + workspace pipeline. The voice UI arrives in Phases 2-3.
export function App() {
  return (
    <main>
      <h1>voice-chat-kit demo</h1>
      <p>
        Phase 0 scaffold. Linked workspace package: <code>{PACKAGE_NAME}</code>
      </p>
    </main>
  );
}
