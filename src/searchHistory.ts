// Persistent recent-search history for the sidebar Search panel. When
// the input is empty we surface the last few queries so the user can
// click-to-rerun instead of retyping common searches across sessions.
//
// Storage shape:
//   localStorage["lcp.searchHistory.v1"] = JSON SearchHistoryEntry[]
//                                          (newest first)
//
// Dedup rule: a "same" entry is one with identical (query, mode,
// caseSensitive). Recording such an entry bumps its `ts` and floats it
// to the top instead of stacking duplicates — reissuing the same search
// 30 times shouldn't evict every other entry from the list.
//
// Cap: MAX_ENTRIES (30). Oldest entries roll off the bottom when the
// list is full. We keep this scoped to a single global key (not per-
// workspace) because the typical user wants the same "ah, that regex
// I wrote last week" to follow them between projects.
//
// Listener pattern mirrors closedTabsStack.ts / bookmarks.ts so the
// SearchPanel can re-render when entries are added or cleared.

import { getJson, setJson } from "./localStore";

export interface SearchHistoryEntry {
  query: string;
  mode: "literal" | "regex";
  caseSensitive: boolean;
  /** Wall-clock millis since epoch — last time this query was run. */
  ts: number;
}

const KEY = "lcp.searchHistory.v1";
const MAX_ENTRIES = 30;

type Listener = () => void;
const listeners = new Set<Listener>();

let _cache: SearchHistoryEntry[] | null = null;

function isValidEntry(v: unknown): v is SearchHistoryEntry {
  if (!v || typeof v !== "object") return false;
  const e = v as SearchHistoryEntry;
  return (
    typeof e.query === "string" &&
    e.query.length > 0 &&
    (e.mode === "literal" || e.mode === "regex") &&
    typeof e.caseSensitive === "boolean" &&
    typeof e.ts === "number"
  );
}

function load(): SearchHistoryEntry[] {
  const parsed = getJson<unknown[]>(KEY, [], Array.isArray).filter(isValidEntry);
  return parsed;
}

function ensureLoaded(): SearchHistoryEntry[] {
  if (_cache) return _cache;
  _cache = load();
  return _cache;
}

function persist(list: SearchHistoryEntry[]): void {
  const trimmed = list.length > MAX_ENTRIES ? list.slice(0, MAX_ENTRIES) : list;
  _cache = trimmed;
  setJson(KEY, trimmed);
  notify();
}

function notify(): void {
  for (const l of listeners) l();
}

/** Subscribe to history changes. Returns an unsubscribe function. */
export function subscribeSearchHistory(cb: Listener): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Newest-first list of recent searches. Returns a copy so callers
 *  can sort / slice without mutating the cache. */
export function getRecentSearches(): SearchHistoryEntry[] {
  return [...ensureLoaded()];
}

/** Record a search. If an entry with matching query+mode+caseSensitive
 *  already exists, its `ts` is bumped and it floats to the top — we do
 *  not keep duplicate rows. Empty queries are ignored. */
export function recordSearch(entry: Omit<SearchHistoryEntry, "ts">): void {
  const query = entry.query;
  if (!query || query.length === 0) return;
  const list = ensureLoaded();
  const next: SearchHistoryEntry[] = [
    { query, mode: entry.mode, caseSensitive: entry.caseSensitive, ts: Date.now() },
    ...list.filter(
      (e) =>
        !(
          e.query === query &&
          e.mode === entry.mode &&
          e.caseSensitive === entry.caseSensitive
        ),
    ),
  ];
  persist(next);
}

/** Wipe the entire history. Used by the panel's "Clear" link. */
export function clearSearchHistory(): void {
  if (ensureLoaded().length === 0) return;
  persist([]);
}
