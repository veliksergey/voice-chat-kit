import type { PointerEvent as ReactPointerEvent } from "react";
import { useCallback, useRef } from "react";

export interface PointerHoldHandlers {
  start(): void | Promise<void>;
  release(): void | Promise<void>;
}

export interface PointerHoldProps {
  onPointerDown(event: ReactPointerEvent<HTMLElement>): void;
  onPointerUp(): void;
  onPointerLeave(): void;
  onPointerCancel(): void;
}

/**
 * Hold-to-talk with a pointer. Release events (`up`, `leave`, `cancel`) act only on a press that
 * this pointer started, so sliding the mouse over the button during a Space-held recording does
 * not end it.
 */
export function usePointerHold(handlers: PointerHoldHandlers): PointerHoldProps {
  const handlersRef = useRef(handlers);
  handlersRef.current = handlers;
  const heldRef = useRef(false);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLElement>): void => {
    event.preventDefault();
    if (heldRef.current) return;
    heldRef.current = true;
    void handlersRef.current.start();
  }, []);

  const releaseIfHeld = useCallback((): void => {
    if (!heldRef.current) return;
    heldRef.current = false;
    void handlersRef.current.release();
  }, []);

  return {
    onPointerDown,
    onPointerUp: releaseIfHeld,
    onPointerLeave: releaseIfHeld,
    onPointerCancel: releaseIfHeld,
  };
}
