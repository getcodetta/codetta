// Line bookmarks sidebar sub-panel — lists every (file, line) bookmark
// the user has set across all loaded workspace files, with click-to-jump.
//
// Companion to BookmarksPanel.tsx (file-level bookmarks). The two share
// the same row visual vocabulary so they read as one bookmark surface
// when stacked together. Where BookmarksPanel pins whole files, this
// panel pins specific lines: the user marks a line via Ctrl+F2 inside
// the editor, and from then on it's reachable from this list without
// having to remember which file it was in.
//
// The lineBookmarks store lives inline in this module. The intent is
// for `src/lineBookmarks.ts` to be the canonical home (matching the
// shape of bookmarks.ts), but until that module is split out the API
// is exported from here so the editor's Ctrl+F2 binding can call into
// `toggleLineBookmark` without a circular reach into a sidebar component.
//
// Storage shape:
//   localStorage["lcp.lineBookmarks"] = JSON Record<path, sorted line[]>
//
// Storage is workspace-agnostic on purpose: line bookmarks are keyed by
// absolute path, so they stay valid as long as the file is still on
// disk at that path, regardless of which workspace happens to be open.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { setEditorGoto } from "../editorState";
import { Icon } from "./Icon";
import { basename, relPath } from "../pathUtils";
import { getJson, setJson } from "../localStore";

// ---------- inline lineBookmarks store ----------

const STORAGE_KEY = "lcp.lineBookmarks";

type LineBookmarkMap = Record<string, number[]>;
type LineBookmarkListener = () => void;

function loadAll(): LineBookmarkMap {
  const raw = getJson<unknown>(STORAGE_KEY, {});
  if (!raw || typeof raw !== "object") return {};
  const out: LineBookmarkMap = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof k !== "string" || !Array.isArray(v)) continue;
    const lines = v.filter(
      (n): n is number => typeof n === "number" && n > 0 && Number.isFinite(n),
    );
    // Dedupe + sort so callers don't need to.
    const uniq = Array.from(new Set(lines)).sort((a, b) => a - b);
    if (uniq.length > 0) out[k] = uniq;
  }
  return out;
}

let cache: LineBookmarkMap | null = null;
const listeners = new Set<LineBookmarkListener>();

function ensureCache(): LineBookmarkMap {
  if (cache === null) cache = loadAll();
  return cache;
}

function persist() {
  if (cache === null) return;
  setJson(STORAGE_KEY, cache);
  for (const l of listeners) l();
}

/** All bookmarked line numbers for the given absolute path. Sorted ascending. */
export function getLineBookmarks(path: string): number[] {
  const c = ensureCache();
  return c[path] ? c[path].slice() : [];
}

/** Subscribe to add/remove events. Fires once per change, with no payload —
 *  callers re-read whatever subset they care about. */
export function subscribeLineBookmarks(cb: LineBookmarkListener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Toggle a line bookmark on (path, line). Returns true if the bookmark
 *  was added, false if it was removed. */
export function toggleLineBookmark(path: string, line: number): boolean {
  const c = ensureCache();
  const cur = c[path] ?? [];
  const idx = cur.indexOf(line);
  if (idx >= 0) {
    const next = cur.slice();
    next.splice(idx, 1);
    if (next.length === 0) delete c[path];
    else c[path] = next;
    persist();
    return false;
  }
  c[path] = [...cur, line].sort((a, b) => a - b);
  persist();
  return true;
}

// ---------- panel ----------

interface Props {
  wsId: string;
  root: string;
}

interface FlatEntry {
  path: string;
  line: number;
}

function snippetForLine(contents: string | null, line: number): string {
  if (contents == null) return "";
  // Lines are 1-indexed by Monaco / setEditorGoto convention.
  const idx = line - 1;
  if (idx < 0) return "";
  // Avoid splitting the entire file when we only need one line — count
  // newlines to find the line's start index, then slice to the next \n.
  let start = 0;
  let cur = 0;
  for (let i = 0; i < contents.length && cur < idx; i++) {
    if (contents.charCodeAt(i) === 10) {
      cur++;
      start = i + 1;
    }
  }
  if (cur < idx) return "";
  let end = contents.indexOf("\n", start);
  if (end < 0) end = contents.length;
  return contents.slice(start, end).trim().slice(0, 200);
}

export function LineBookmarksPanel({ wsId, root }: Props) {
  // Bump on every store change so we re-flatten the map. Cheap — there
  // are typically <50 entries even in heavy use.
  const [version, setVersion] = useState(0);

  useEffect(() => {
    const unsub = subscribeLineBookmarks(() => setVersion((v) => v + 1));
    return unsub;
  }, []);

  const wsFiles = useStore((s) => s.loaded[wsId]?.files ?? null);

  const entries = useMemo<FlatEntry[]>(() => {
    // Touch `version` so the memo invalidates whenever the store fires.
    void version;
    const all = ensureCache();
    const out: FlatEntry[] = [];
    for (const [path, lines] of Object.entries(all)) {
      for (const line of lines) out.push({ path, line });
    }
    // Group by path (preserving the path-insertion order from the map),
    // lines already ascending.
    return out;
  }, [version]);

  const onOpen = (e: FlatEntry) => {
    void useStore
      .getState()
      .openFile(wsId, e.path)
      .then(() => setEditorGoto(e.line, 1));
  };

  const onRemove = (e: FlatEntry) => {
    toggleLineBookmark(e.path, e.line);
  };

  return (
    <div className="bookmarks-panel">
      <div className="bookmarks-panel-header">
        <span>Line Bookmarks</span>
        {entries.length > 0 && (
          <span className="bookmarks-count">{entries.length}</span>
        )}
      </div>

      {entries.length === 0 && (
        <div className="bookmarks-empty">
          No line bookmarks yet. Press <strong>Ctrl+F2</strong> inside an
          editor to add a bookmark.
        </div>
      )}

      <div className="bookmarks-list">
        {entries.map((e) => {
          const file = wsFiles?.[e.path];
          const snippet = snippetForLine(file?.contents ?? null, e.line);
          const rel = relPath(e.path, root) || e.path;
          return (
            <div key={`${e.path}:${e.line}`} className="bookmarks-row">
              <button
                className="bookmarks-row-main"
                onClick={() => onOpen(e)}
                title={`${e.path}:${e.line}`}
              >
                <Icon name="hash" size={11} className="bookmarks-star" />
                <div className="bookmarks-meta">
                  <span className="bookmarks-name">
                    {basename(e.path)} : {e.line}
                  </span>
                  <span className="bookmarks-rel">{rel}</span>
                  {snippet && (
                    <span className="bookmarks-note">{snippet}</span>
                  )}
                </div>
              </button>
              <div className="bookmarks-actions">
                <button
                  className="bookmarks-action bookmarks-action-danger"
                  onClick={() => onRemove(e)}
                  title="Remove bookmark"
                  aria-label={`Remove bookmark at ${basename(e.path)} line ${e.line}`}
                >
                  <Icon name="x" size={11} />
                </button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
