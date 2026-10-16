import type { ProvidersInfo, SttProvider } from "@voice-chat-kit/core";
import { deepgramStt, webSpeechStt } from "@voice-chat-kit/providers/stt";
import { useVoiceChat } from "@voice-chat-kit/react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { usePointerHold } from "./usePointerHold.js";
import { usePushToTalkKey } from "./usePushToTalkKey.js";

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
  row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
  input: { flex: 1, padding: 10, fontSize: 16 },
  ptt: { padding: "14px 24px", fontSize: 18, borderRadius: 999, cursor: "pointer", minWidth: 180 },
  pttActive: { background: "#fecaca" },
  interim: { minHeight: 24, fontStyle: "italic", color: "#374151", margin: "8px 0" },
  muted: { color: "#6b7280", fontSize: 14 },
} as const;

export function App() {
  const [providers, setProviders] = useState<ProvidersInfo | null>(null);
  const [draft, setDraft] = useState("");
  const [sttId, setSttId] = useState("");

  useEffect(() => {
    fetch("/api/providers")
      .then((r) => (r.ok ? (r.json() as Promise<ProvidersInfo>) : null))
      .then(setProviders)
      .catch(() => setProviders(null));
  }, []);

  // Offer only what works here: Web Speech when the browser has it, Deepgram when the server
  // can mint its tokens.
  const sttChoices = useMemo(() => {
    const list: SttProvider[] = [];
    const web = webSpeechStt();
    if (web.isSupported?.() ?? true) list.push(web);
    if (providers?.tokenIssuers.includes("deepgram")) list.push(deepgramStt());
    return list;
  }, [providers]);
  const stt = sttChoices.find((p) => p.id === sttId) ?? sttChoices[0];

  const chat = useVoiceChat({ baseUrl: "/api", ...(stt ? { stt } : {}) });
  const { startListening, stopListening } = chat;
  const busy = chat.state !== "idle" && chat.state !== "error";
  const listening = chat.state === "listening";

  // Hold Space to talk (on the page or the PTT button); losing focus cancels instead of sending.
  usePushToTalkKey({
    start: startListening,
    release: stopListening,
    cancel: chat.stop,
    isActive: () => listening,
  });
  // Pointer hold-to-talk; its release events apply only to presses the pointer started.
  const pointerHold = usePointerHold({ start: startListening, release: stopListening });

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
        Phase 2: push-to-talk with Claude. State: <strong>{chat.state}</strong>
        {chat.usage
          ? ` · last turn ${chat.usage.inputTokens} in / ${chat.usage.outputTokens} out`
          : ""}
      </p>

      <div style={styles.row}>
        <label htmlFor="stt">Speech-to-text</label>
        <select
          id="stt"
          value={stt?.id ?? ""}
          onChange={(e) => setSttId(e.target.value)}
          disabled={busy || sttChoices.length === 0}
        >
          {sttChoices.length === 0 ? <option value="">none available</option> : null}
          {sttChoices.map((p) => (
            <option key={p.id} value={p.id}>
              {p.id === "web-speech" ? "Web Speech API (free, browser)" : "Deepgram Nova-3"}
            </option>
          ))}
        </select>
        {stt?.id === "web-speech" ? (
          <span style={styles.muted}>Chrome sends this audio to Google's servers.</span>
        ) : null}
      </div>

      <section style={styles.log} aria-live="polite">
        {chat.messages.map((m) => (
          <div key={m.id} style={m.role === "user" ? styles.user : styles.assistant}>
            {m.text || (m.status === "streaming" ? "…" : "")}
            {m.status === "refused" ? <span style={styles.muted}> (refused)</span> : null}
            {m.status === "error" ? <span style={styles.muted}> (failed)</span> : null}
          </div>
        ))}
      </section>

      <p style={styles.interim} aria-live="polite">
        {listening ? chat.interimTranscript || "Listening…" : ""}
        {chat.state === "transcribing" ? "Finishing transcript…" : ""}
      </p>

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

      <div style={styles.row}>
        <button
          type="button"
          data-ptt="true"
          style={{ ...styles.ptt, ...(listening ? styles.pttActive : {}) }}
          disabled={!stt || (busy && !listening)}
          {...pointerHold}
          aria-pressed={listening}
        >
          {listening ? "Release to send" : "Hold to talk (or hold Space)"}
        </button>
        <button type="button" onClick={chat.stop} disabled={!busy}>
          Stop
        </button>
        <button type="button" onClick={chat.newConversation} disabled={chat.messages.length === 0}>
          New conversation
        </button>
      </div>

      <form onSubmit={onSubmit} style={{ ...styles.row, marginTop: 12 }}>
        <input
          style={styles.input}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="…or type a message"
          disabled={busy}
          aria-label="Message"
        />
        <button type="submit" disabled={busy || !draft.trim()}>
          Send
        </button>
      </form>
    </main>
  );
}
