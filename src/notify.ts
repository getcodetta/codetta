import { useEffect, useState } from "react";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  timeoutMs: number;
}

let _toasts: Toast[] = [];
let _nextId = 1;
const listeners = new Set<(t: Toast[]) => void>();

// Per-toast auto-dismiss timer + remaining time, so hover can pause
// the countdown and unhover can resume from where it left off.
// Without this, longer error toasts vanish mid-read because the user
// hovered to read them and the 8s timer ran out anyway.
interface TimerState {
  handle: number;
  startedAt: number;
  remaining: number;
}
const timers = new Map<number, TimerState>();

function scheduleDismiss(id: number, ms: number): void {
  const handle = window.setTimeout(() => {
    timers.delete(id);
    dismissToast(id);
  }, ms);
  timers.set(id, { handle, startedAt: Date.now(), remaining: ms });
}

export function pauseToast(id: number): void {
  const t = timers.get(id);
  if (!t) return;
  window.clearTimeout(t.handle);
  const elapsed = Date.now() - t.startedAt;
  const left = Math.max(500, t.remaining - elapsed);
  // Sentinel handle 0 = paused; resume needs a fresh schedule.
  timers.set(id, { handle: 0, startedAt: Date.now(), remaining: left });
}

export function resumeToast(id: number): void {
  const t = timers.get(id);
  if (!t || t.handle !== 0) return;
  scheduleDismiss(id, t.remaining);
}

function notifyListeners() {
  for (const l of listeners) l(_toasts);
}

function defaultTimeout(kind: ToastKind): number {
  switch (kind) {
    case "warning":
      return 6000;
    case "error":
      return 8000;
    case "info":
    case "success":
    default:
      return 4000;
  }
}

export function notify(
  message: string,
  kind: ToastKind = "info",
  timeoutMs?: number,
): void {
  const id = _nextId++;
  const finalTimeout = timeoutMs ?? defaultTimeout(kind);
  const toast: Toast = { id, kind, message, timeoutMs: finalTimeout };
  _toasts = [..._toasts, toast];
  notifyListeners();
  if (finalTimeout > 0) {
    scheduleDismiss(id, finalTimeout);
  }
}

export function info(message: string): void {
  notify(message, "info");
}

export function success(message: string): void {
  notify(message, "success");
}

export function warning(message: string): void {
  notify(message, "warning");
}

export function error(message: string): void {
  notify(message, "error");
}

export function dismissToast(id: number): void {
  const next = _toasts.filter((t) => t.id !== id);
  if (next.length === _toasts.length) return;
  _toasts = next;
  // Clear any pending auto-dismiss timer so manual close + auto-close
  // don't double-fire on the next id reuse.
  const t = timers.get(id);
  if (t && t.handle !== 0) window.clearTimeout(t.handle);
  timers.delete(id);
  notifyListeners();
}

export function useToasts(): Toast[] {
  const [t, setT] = useState<Toast[]>(_toasts);
  useEffect(() => {
    listeners.add(setT);
    return () => {
      listeners.delete(setT);
    };
  }, []);
  return t;
}

/**
 * Normalize whatever was thrown into a human-readable string for a toast.
 * Tauri invoke rejections come back as plain strings (the Rust side does
 * .map_err(|e| e.to_string())); JS code may throw real Error instances;
 * library code occasionally rejects with non-Error values. Without a
 * single helper we end up with a mix of "Error: foo" / raw "foo" /
 * "[object Object]" depending on the call site. errMsg flattens to the
 * inner message string everywhere.
 */
export function errMsg(e: unknown): string {
  if (typeof e === "string") return e;
  if (e instanceof Error) return e.message;
  if (e && typeof e === "object" && "message" in e) {
    const m = (e as { message: unknown }).message;
    if (typeof m === "string") return m;
  }
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}
