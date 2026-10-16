import type { ProvidersInfo } from "@voice-chat-kit/core";
import { useVoiceChat } from "@voice-chat-kit/react";
import { type FormEvent, useEffect, useState } from "react";

const styles = {
  main: { maxWidth: 720, margin: "0 auto", padding: 16, fontFamily: "system-ui, sans-serif" },
  log: { display: "flex", flexDirection: "column", gap: 8, margin: "16px 0", minHeight: 200 },
  user: {
    alignSelf: "flex-end",
    background: "#dbeafe",
    padding: "8px 12px",
    borderRadius: 12,
    maxWidth: "85%",
  },
  assistant: {
    alignSelf: "flex-start",
    background: "#f3f4f6",
    padding: "8px 12px",
    borderRadius: 12,
    maxWidth: "85%",
  },
  notice: { padding: "8px 12px", borderRadius: 8, background: "#fef3c7", margin: "8px 0" },
  error: { padding: "8px 12px", borderRadius: 8, background: "#fee2e2", margin: "8px 0" },
  form: { display: "flex", gap: 8 },
  input: { flex: 1, padding: 10, fontSize: 16 },
  muted: { color: "#6b7280", fontSize: 14 },
} as const;

export function App() {
  const chat = useVoiceChat({ baseUrl: "/api" });
  const [draft, setDraft] = useState("");
  const [providers, setProviders] = useState<ProvidersInfo | null>(null);

  useEffect(() => {
    fetch("/api/providers")
      .then((r) => (r.ok ? (r.json() as Promise<ProvidersInfo>) : null))
      .then(setProviders)
      .catch(() => setProviders(null));
  }, []);

  const busy = chat.state !== "idle" && chat.state !== "error";

  function onSubmit(event: FormEvent): void {
    event.preventDefault();
    const text = draft;
    setDraft("");
    void chat.sendText(text);
  }

  return (
    <main style={styles.main}>
      <h1>voice-chat-kit demo</h1>
      <p style={styles.muted}>
        Phase 1: text chat with Claude. State: <strong>{chat.state}</strong>
        {providers
          ? ` · token issuers: ${providers.tokenIssuers.length ? providers.tokenIssuers.join(", ") : "none"}`
          : ""}
        {chat.usage
          ? ` · last turn ${chat.usage.inputTokens} in / ${chat.usage.outputTokens} out`
          : ""}
      </p>

      <section style={styles.log} aria-live="polite">
        {chat.messages.map((m) => (
          <div key={m.id} style={m.role === "user" ? styles.user : styles.assistant}>
            {m.text || (m.status === "streaming" ? "…" : "")}
            {m.status === "refused" ? <span style={styles.muted}> (refused)</span> : null}
            {m.status === "error" ? <span style={styles.muted}> (failed)</span> : null}
          </div>
        ))}
      </section>

      {chat.lastRefusal ? (
        <div style={styles.notice} role="status">
          Claude declined this request
          {chat.lastRefusal.category ? ` (${chat.lastRefusal.category})` : ""}.
          {chat.lastRefusal.explanation ? ` ${chat.lastRefusal.explanation}` : ""} The turn was
          removed from the conversation sent to Claude.
        </div>
      ) : null}
      {chat.lastFallback ? (
        <div style={styles.notice} role="status">
          {chat.lastFallback.from} declined; {chat.lastFallback.to} answered instead.
        </div>
      ) : null}
      {chat.error ? (
        <div style={styles.error} role="alert">
          {chat.error}
        </div>
      ) : null}

      <form onSubmit={onSubmit} style={styles.form}>
        <input
          style={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Type a message…"
          disabled={busy}
          aria-label="Message"
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
        <button type="button" onClick={chat.stop} disabled={!busy}>
          Stop
        </button>
        <button type="button" onClick={chat.newConversation} disabled={chat.messages.length === 0}>
          New conversation
        </button>
      </form>
    </main>
  );
}
