// In-memory line-level bookmarks keyed by absolute file path.
//
// Distinct from src/bookmarks.ts (which is the file-level bookmarks
// store): this module tracks bookmarked LINES inside a single file,
// used by the F2 / Shift+F2 / Ctrl+F2 jump-and-toggle actions in the
// Monaco editor.
//
// Why session-scoped (not persisted): the same rationale as
// closedTabsStack — line numbers are a fragile anchor across edits.
// Persisting "line 42 of foo.ts" across an app restart would point
// at whatever happens to be on line 42 next time, which is rarely
// what the user originally bookmarked. Reopening the file with
// stale ticks scattered around would be more confusing than helpful,
// so we keep it in memory and let the user re-toggle as needed.
//
// Cap: PER_FILE_LIMIT bookmarks per file, dropping the oldest
// (lowest line number) when the cap is exceeded — this is a backstop
// against a runaway loop that toggles bookmarks programmatically;
// no real user is going to bookmark 100 lines in one file.
const PER_FILE_LIMIT = 100;

const bookmarks = new Map<string, Set<number>>();
const listeners = new Set<(path: string) => void>();

function notify(path: string) {
  for (const l of listeners) l(path);
}

/** Toggle a bookmark at `line` (1-based) for `path`. Returns the
 *  new state — true when the line is now bookmarked, false when it
 *  was just removed. */
export function toggleLineBookmark(path: string, line: number): boolean {
  if (!Number.isFinite(line) || line < 1) return false;
  let set = bookmarks.get(path);
  if (!set) {
    set = new Set<number>();
    bookmarks.set(path, set);
  }
  let nowOn: boolean;
  if (set.has(line)) {
    set.delete(line);
    nowOn = false;
  } else {
    set.add(line);
    nowOn = true;
    if (set.size > PER_FILE_LIMIT) {
      // Drop the smallest line number to keep the cap. Sorted ascending
      // so the first iterator value is the lowest.
      const oldest = [...set].sort((a, b) => a - b)[0];
      set.delete(oldest);
    }
  }
  if (set.size === 0) bookmarks.delete(path);
  notify(path);
  return nowOn;
}

/** All bookmarked lines for `path`, sorted ascending. */
export function getLineBookmarks(path: string): number[] {
  const set = bookmarks.get(path);
  if (!set || set.size === 0) return [];
  return [...set].sort((a, b) => a - b);
}

/** Snapshot of every (path, line) pair across every file. Used by the
 *  sidebar list panel which needs to enumerate the whole store rather
 *  than asking about one path at a time. */
export function getAllLineBookmarks(): Array<{ path: string; line: number }> {
  const out: Array<{ path: string; line: number }> = [];
  for (const [path, set] of bookmarks) {
    for (const line of [...set].sort((a, b) => a - b)) {
      out.push({ path, line });
    }
  }
  return out;
}

/** First bookmark strictly after `fromLine`, wrapping to the lowest
 *  bookmark when none is found above. Returns null when the file has
 *  no bookmarks at all. */
export function nextLineBookmark(
  path: string,
  fromLine: number,
): number | null {
  const lines = getLineBookmarks(path);
  if (lines.length === 0) return null;
  for (const l of lines) {
    if (l > fromLine) return l;
  }
  return lines[0];
}

/** First bookmark strictly before `fromLine`, wrapping to the highest
 *  bookmark when none is found below. Returns null when the file has
 *  no bookmarks at all. */
export function prevLineBookmark(
  path: string,
  fromLine: number,
): number | null {
  const lines = getLineBookmarks(path);
  if (lines.length === 0) return null;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (lines[i] < fromLine) return lines[i];
  }
  return lines[lines.length - 1];
}

export function subscribeLineBookmarks(
  cb: (path: string) => void,
): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}
