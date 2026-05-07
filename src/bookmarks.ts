// Per-workspace pinned-files store. The user explicitly bookmarks
// files via the file tree right-click menu; the Bookmarks sidebar
// panel and the optional pin-marker on tab labels read from this
// store. Distinct from recentFiles.ts (the Ctrl+Tab move-to-front
// overlay), which is auto-populated and ephemeral.
//
// Storage shape:
//   localStorage["lcp.bookmarks.<wsId>"] = JSON Bookmark[] (newest first)
//
// Two reasons we put the wsId in the storage key instead of nesting
// everything under one key:
//   1. Switching workspaces shouldn't read+rewrite a giant blob.
//   2. Per-workspace caps mean a project with hundreds of pins can't
//      bleed into another project's storage.

import { getJson, setJson } from "./localStore";

export interface Bookmark {
  /** Absolute path in the local filesystem. Same shape as openFile uses. */
  path: string;
  /** Wall-clock millis when the bookmark was added — used to render
   *  "added 5m ago" / "added yesterday" in the panel. */
  addedAt: number;
  /** Optional one-liner shown in the panel below the filename. Lets
   *  the user remember why they pinned this file ("entry point",
   *  "broken — fix tomorrow", etc.). */
  note?: string;
}

const KEY = (wsId: string) => `lcp.bookmarks.${wsId}`;
const MAX_PER_WORKSPACE = 200;

// In-memory cache + change listeners so the FileTree right-click menu
// (which reads the live state via subscribeBookmarks) stays in sync
// with the Bookmarks panel without an event-bus round-trip.
const cache = new Map<string, Bookmark[]>();
type Listener = (wsId: string) => void;
const listeners = new Set<Listener>();

function notify(wsId: string) {
  for (const l of listeners) l(wsId);
}

export function subscribeBookmarks(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function loadBookmarks(wsId: string): Bookmark[] {
  const hit = cache.get(wsId);
  if (hit) return hit;
  const parsed = getJson<unknown[]>(KEY(wsId), [], Array.isArray).filter(
    (b): b is Bookmark =>
      !!b &&
      typeof b === "object" &&
      typeof (b as Bookmark).path === "string" &&
      typeof (b as Bookmark).addedAt === "number",
  );
  cache.set(wsId, parsed);
  return parsed;
}

function persist(wsId: string, list: Bookmark[]) {
  // Cap at MAX_PER_WORKSPACE — drop oldest first so a runaway "pin
  // every file" loop can't grow localStorage unbounded.
  const trimmed =
    list.length > MAX_PER_WORKSPACE
      ? list.slice(0, MAX_PER_WORKSPACE)
      : list;
  cache.set(wsId, trimmed);
  setJson(KEY(wsId), trimmed);
  notify(wsId);
}

export function isBookmarked(wsId: string, path: string): boolean {
  return loadBookmarks(wsId).some((b) => b.path === path);
}

export function addBookmark(wsId: string, path: string, note?: string) {
  const existing = loadBookmarks(wsId);
  if (existing.some((b) => b.path === path)) return;
  persist(wsId, [
    { path, addedAt: Date.now(), note: note?.trim() || undefined },
    ...existing,
  ]);
}

export function removeBookmark(wsId: string, path: string) {
  const existing = loadBookmarks(wsId);
  const next = existing.filter((b) => b.path !== path);
  if (next.length === existing.length) return;
  persist(wsId, next);
}

export function toggleBookmark(wsId: string, path: string): boolean {
  if (isBookmarked(wsId, path)) {
    removeBookmark(wsId, path);
    return false;
  }
  addBookmark(wsId, path);
  return true;
}

export function setBookmarkNote(wsId: string, path: string, note: string) {
  const list = loadBookmarks(wsId);
  const idx = list.findIndex((b) => b.path === path);
  if (idx < 0) return;
  const next = [...list];
  next[idx] = { ...next[idx], note: note.trim() || undefined };
  persist(wsId, next);
}

/** Drop bookmarks whose path matches `from` and re-add under `to`.
 *  Used by the file tree's rename handler. */
export function renameBookmark(wsId: string, from: string, to: string) {
  const list = loadBookmarks(wsId);
  const idx = list.findIndex((b) => b.path === from);
  if (idx < 0) return;
  const next = [...list];
  next[idx] = { ...next[idx], path: to };
  persist(wsId, next);
}
