// Per-workspace LIFO of recently closed file tabs, used by Ctrl+Shift+T
// (Reopen Closed Tab) and the optional history menu.
//
// Why a separate module instead of a slot on WorkspaceData: the stack
// is purely in-memory session state (path + timestamp), and we don't
// want it serialised into state.json — restoring "closed tabs" across
// app restarts would surprise users by quietly resurrecting tabs they
// thought they were rid of. Keeping it here also dodges the migration
// dance every time WorkspaceData's shape changes.
//
// Cap: STACK_LIMIT entries per workspace. Oldest entries roll off the
// bottom when the stack is full.

import { fileKey } from "./store";

const STACK_LIMIT = 20;

export interface ClosedTab {
  /** Absolute path of the closed file. */
  path: string;
  /** Millis since epoch — used by the history menu to render
   *  "closed 12s ago" hints. */
  closedAt: number;
}

const stacks = new Map<string, ClosedTab[]>();
const listeners = new Set<(wsId: string) => void>();

function notify(wsId: string) {
  for (const l of listeners) l(wsId);
}

/** Record that a file tab was just closed. Adjacent duplicates collapse
 *  so rapidly toggling the same tab doesn't crowd out older entries. */
export function pushClosedTab(wsId: string, path: string): void {
  const list = stacks.get(wsId) ?? [];
  const top = list[list.length - 1];
  if (top && top.path === path) {
    top.closedAt = Date.now();
  } else {
    list.push({ path, closedAt: Date.now() });
    if (list.length > STACK_LIMIT) list.splice(0, list.length - STACK_LIMIT);
  }
  stacks.set(wsId, list);
  notify(wsId);
}

/** Pop the most recently closed tab. Returns null when the stack is
 *  empty. Caller is responsible for re-opening the file via the store. */
export function popClosedTab(wsId: string): ClosedTab | null {
  const list = stacks.get(wsId);
  if (!list || list.length === 0) return null;
  const entry = list.pop()!;
  stacks.set(wsId, list);
  notify(wsId);
  return entry;
}

export function peekClosedTabs(wsId: string): ClosedTab[] {
  const list = stacks.get(wsId);
  // Newest first — matches how a "history" menu wants to render.
  return list ? [...list].reverse() : [];
}

/** Drop a specific path from the stack — invoked when the file is
 *  reopened by some other route (sidebar click, recent files menu)
 *  so Ctrl+Shift+T doesn't redundantly try to resurrect it. */
export function forgetClosedTab(wsId: string, path: string): void {
  const list = stacks.get(wsId);
  if (!list) return;
  const next = list.filter((t) => t.path !== path);
  if (next.length === list.length) return;
  stacks.set(wsId, next);
  notify(wsId);
}

export function clearClosedTabs(wsId: string): void {
  if (stacks.delete(wsId)) notify(wsId);
}

export function subscribeClosedTabs(cb: (wsId: string) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

// Re-export fileKey so callers don't need a separate import to derive
// a tab key from a path when they want to check whether a path is
// already open before pushing.
export { fileKey };
