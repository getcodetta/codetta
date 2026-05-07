// Pre-turn file snapshots used by the AI compose card's "Revert all"
// action. When the user sends a message to an agentic provider that's
// likely to modify files (Claude Code), we snapshot the contents of
// every file currently open in the workspace just before the turn
// fires. After the turn lands, the ComposeCard can offer to roll the
// changes back by writing each file's snapshot value back to disk.
//
// In-memory only — no localStorage, no Rust state. Snapshots are
// dropped automatically on workspace switch / chat clear / explicit
// revert. Memory cost is bounded by the number of currently-open
// editor buffers (typically <30) × file size (capped to 1 MB each).

const MAX_PER_FILE_BYTES = 1_000_000;

export interface TurnSnapshot {
  /** wall-clock ms when the snapshot was captured. */
  ts: number;
  /** absolute path → contents at snapshot time. */
  files: Map<string, string>;
}

// Keyed by `${wsId}:${chatId}:${turnIndex}`. turnIndex is the assistant
// message index that the snapshot belongs to — the next push to the
// messages array. ComposeCard reads it back by the same key.
const snapshots = new Map<string, TurnSnapshot>();

function key(wsId: string, chatId: string | undefined, turnIndex: number): string {
  return `${wsId}:${chatId ?? "_"}:${turnIndex}`;
}

/** Capture a snapshot of every open buffer's current contents. The
 *  caller passes the workspace files map (typically `ws.files` from
 *  the Zustand store). */
export function captureSnapshot(
  wsId: string,
  chatId: string | undefined,
  turnIndex: number,
  files: Record<string, { contents: string }>,
): void {
  const map = new Map<string, string>();
  for (const [path, f] of Object.entries(files)) {
    if (typeof f?.contents !== "string") continue;
    if (f.contents.length > MAX_PER_FILE_BYTES) continue;
    map.set(path, f.contents);
  }
  if (map.size === 0) return;
  // If this key already exists, delete first so re-set re-positions it
  // at the back of the insertion-ordered map. Without this, re-capturing
  // the same turn (rare but possible during a retry) leaves the original
  // entry at its old position and the eviction below could drop the
  // newer copy.
  snapshots.delete(key(wsId, chatId, turnIndex));
  snapshots.set(key(wsId, chatId, turnIndex), { ts: Date.now(), files: map });
  // Bound total memory: keep at most 20 snapshots across the app
  // (chats older than that lose the revert option, which is fine —
  // reverting an hour-old change isn't a real workflow). Map iteration
  // order is insertion order, so .keys().next() is the oldest entry —
  // O(1) eviction instead of the previous sort-the-entries approach.
  while (snapshots.size > 20) {
    const oldest = snapshots.keys().next().value;
    if (oldest === undefined) break;
    snapshots.delete(oldest);
  }
}

export function lookupSnapshot(
  wsId: string,
  chatId: string | undefined,
  turnIndex: number,
): TurnSnapshot | null {
  return snapshots.get(key(wsId, chatId, turnIndex)) ?? null;
}

export function dropSnapshot(
  wsId: string,
  chatId: string | undefined,
  turnIndex: number,
): void {
  snapshots.delete(key(wsId, chatId, turnIndex));
}

export function dropChatSnapshots(wsId: string, chatId?: string): void {
  const prefix = `${wsId}:${chatId ?? "_"}:`;
  for (const k of [...snapshots.keys()]) {
    if (k.startsWith(prefix)) snapshots.delete(k);
  }
}
