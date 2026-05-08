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

// ---------------------------------------------------------------------------
// Session-scoped notification history
//
// Toasts auto-dismiss after a few seconds; if the user looked away (or a
// background poll fired off five errors at once) they have no way to go
// back and read what scrolled by. We mirror every emitted notify() call
// into a bounded ring buffer that the "Show Notifications" palette command
// surfaces in a modal.
//
// The cap exists for two reasons:
//   1. Stop a runaway poll loop from pinning megabytes of message strings
//      in memory across an all-day editor session.
//   2. Keep the modal scannable — past 200 entries you're not reading the
//      list anyway, you're searching it (which the filter input handles).
//
// Persistence is intentionally NOT done. A fresh app launch starting with a
// pristine, empty history is the right default; carrying yesterday's
// "Save failed" toasts forward would be noise and wouldn't tell the user
// anything actionable about THIS session.
// ---------------------------------------------------------------------------

export interface ToastRecord {
  id: string;
  ts: number;
  kind: ToastKind;
  message: string;
}

const HISTORY_CAP = 200;
let historyArr: ToastRecord[] = [];
let _historyIdSeq = 1;
const historyListeners = new Set<() => void>();

function pushHistory(kind: ToastKind, message: string): void {
  const rec: ToastRecord = {
    id: `tr-${_historyIdSeq++}`,
    ts: Date.now(),
    kind,
    message,
  };
  historyArr.push(rec);
  // Drop the oldest in chunks rather than one-at-a-time when many calls
  // happen in a tight loop. Bounded by HISTORY_CAP so the array can never
  // outgrow the cap by more than the size of a single error storm.
  if (historyArr.length > HISTORY_CAP) {
    historyArr = historyArr.slice(historyArr.length - HISTORY_CAP);
  }
  for (const l of historyListeners) l();
}

/**
 * Returns a copy of the toast history, newest entries first. We hand back
 * a copy rather than the live array so callers can't mutate the buffer
 * (and so React's reference-equality memoization picks up changes).
 */
export function getToastHistory(): ToastRecord[] {
  // slice() then reverse() — slice clones, reverse mutates the clone.
  return historyArr.slice().reverse();
}

export function clearToastHistory(): void {
  if (historyArr.length === 0) return;
  historyArr = [];
  for (const l of historyListeners) l();
}

export function subscribeToastHistory(cb: () => void): () => void {
  historyListeners.add(cb);
  return () => {
    historyListeners.delete(cb);
  };
}

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
  // Record into history BEFORE the dedupe / cap logic kicks in below.
  // The visible toast queue collapses repeats, but the history view
  // should still show every individual occurrence — that's the whole
  // point of having a log the user can scroll back through.
  pushHistory(kind, message);
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
