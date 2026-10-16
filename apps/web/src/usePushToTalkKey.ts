import { useEffect, useRef } from "react";

export interface PushToTalkKeyHandlers {
  /** Key pressed: begin listening. */
  start(): void | Promise<void>;
  /** Key released normally: finish and send. */
  release(): void | Promise<void>;
  /** The press can no longer be released here (focus lost): abort without sending. */
  cancel(): void;
  /** Whether a recording is in progress (covers pointer-driven presses on focus loss). */
  isActive(): boolean;
}

export interface PushToTalkKeyOptions {
  /** `KeyboardEvent.code`; Space by default. */
  code?: string;
  enabled?: boolean;
}

/**
 * Where the shortcut applies: the page itself or the push-to-talk button (`data-ptt="true"`).
 * Any other focused control keeps its native Space behaviour (activating Stop, opening the
 * selector, typing a space).
 */
export function isPushToTalkTarget(target: EventTarget | null): boolean {
  if (target === null) return true;
  if (!(target instanceof HTMLElement)) return false;
  if (target === document.body || target === document.documentElement) return true;
  return target.dataset.ptt === "true";
}

/**
 * Hold-to-talk on a key. A press that cannot be released in this window (blur, tab hidden) is
 * cancelled rather than left recording, and the late keyup is ignored.
 */
export function usePushToTalkKey(
  handlers: PushToTalkKeyHandlers,
  options: PushToTalkKeyOptions = {},
): void {
  const code = options.code ?? "Space";
  const enabled = options.enabled ?? true;
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;

  useEffect(() => {
    if (!enabled) return;
    let held = false;

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.code !== code || event.repeat || !isPushToTalkTarget(event.target)) return;
      event.preventDefault();
      if (held) return;
      held = true;
      void handlersRef.current.start();
    };
    const onKeyUp = (event: KeyboardEvent): void => {
      if (event.code !== code || !held) return;
      event.preventDefault();
      held = false;
      void handlersRef.current.release();
    };
    const onFocusLost = (): void => {
      const wasHeld = held;
      held = false;
      if (wasHeld || handlersRef.current.isActive()) handlersRef.current.cancel();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") onFocusLost();
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onFocusLost);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onFocusLost);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [code, enabled]);
}
