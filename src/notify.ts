import { useEffect, useState } from "react";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  timeoutMs: number;
  /** When the same kind+message arrives repeatedly in a short window, we
   *  collapse them into a single toast and bump this counter so the user
   *  sees "Save failed (×3)" instead of three identical stacked toasts. */
  count: number;
}

// Cap to keep error storms from burying the rest of the UI. When a poll
// loop or watcher fails repeatedly, we'd rather show the most recent
// few than 50 stacked cards. Newest at the bottom; oldest is dropped
// silently when the stack hits this size.
const MAX_VISIBLE_TOASTS = 6;
// Within this window, a duplicate (kind+message) increments .count on
// the existing toast instead of pushing a new card. 1.2s feels right —
// long enough to catch tight retry loops, short enough that intentional
// re-shows after a user retried still surface.
const DUPLICATE_WINDOW_MS = 1200;

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

// Track when each (kind, message) pair was last surfaced so we can
// collapse duplicates that arrive in a tight window into a single
// counter-bumped card.
const lastSeen = new Map<string, { id: number; at: number }>();

function dedupeKey(kind: ToastKind, message: string): string {
  return kind + "\0" + message;
}

export function notify(
  message: string,
  kind: ToastKind = "info",
  timeoutMs?: number,
): void {
  const finalTimeout = timeoutMs ?? defaultTimeout(kind);
  const key = dedupeKey(kind, message);
  const seen = lastSeen.get(key);
  const now = Date.now();
  if (seen && now - seen.at < DUPLICATE_WINDOW_MS) {
    // Bump the count on the existing toast and reset its dismiss timer
    // so a fresh repeat resurfaces the card cleanly. We keep the same
    // id so React doesn't reanimate the entry from scratch.
    const existing = _toasts.find((t) => t.id === seen.id);
    if (existing) {
      _toasts = _toasts.map((t) =>
        t.id === seen.id ? { ...t, count: t.count + 1 } : t,
      );
      lastSeen.set(key, { id: seen.id, at: now });
      notifyListeners();
      const tState = timers.get(seen.id);
      if (tState && tState.handle !== 0) window.clearTimeout(tState.handle);
      timers.delete(seen.id);
      if (existing.timeoutMs > 0) scheduleDismiss(seen.id, existing.timeoutMs);
      return;
    }
  }
  const id = _nextId++;
  const toast: Toast = { id, kind, message, timeoutMs: finalTimeout, count: 1 };
  let next = [..._toasts, toast];
  // Drop oldest cards until the stack fits MAX_VISIBLE_TOASTS. Clear
  // their dismiss timers + dedupe entries so they don't leak.
  while (next.length > MAX_VISIBLE_TOASTS) {
    const dropped = next.shift()!;
    const t = timers.get(dropped.id);
    if (t && t.handle !== 0) window.clearTimeout(t.handle);
    timers.delete(dropped.id);
    const k = dedupeKey(dropped.kind, dropped.message);
    if (lastSeen.get(k)?.id === dropped.id) lastSeen.delete(k);
  }
  _toasts = next;
  lastSeen.set(key, { id, at: now });
  notifyListeners();
  if (finalTimeout > 0) scheduleDismiss(id, finalTimeout);
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
  const dropping = _toasts.find((t) => t.id === id);
  if (!dropping) return;
  _toasts = _toasts.filter((t) => t.id !== id);
  // Clear any pending auto-dismiss timer so manual close + auto-close
  // don't double-fire on the next id reuse.
  const t = timers.get(id);
  if (t && t.handle !== 0) window.clearTimeout(t.handle);
  timers.delete(id);
  // Drop the dedupe pointer so the next identical message starts fresh
  // (otherwise it'd try to bump a count on a toast that no longer exists).
  const k = dedupeKey(dropping.kind, dropping.message);
  if (lastSeen.get(k)?.id === id) lastSeen.delete(k);
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
