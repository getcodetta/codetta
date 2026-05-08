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
// Reads from the canonical session-scoped store at src/lineBookmarks.ts
// (in-memory, deliberately not persisted across restarts — see that
// file's header for the rationale).

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { setEditorGoto } from "../editorState";
import { Icon } from "./Icon";
import { basename, relPath } from "../pathUtils";
import {
  getAllLineBookmarks,
  subscribeLineBookmarks,
  toggleLineBookmark,
} from "../lineBookmarks";

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
    return subscribeLineBookmarks(() => setVersion((v) => v + 1));
  }, []);

  const wsFiles = useStore((s) => s.loaded[wsId]?.files ?? null);

  const entries = useMemo<FlatEntry[]>(() => {
    void version;
    return getAllLineBookmarks();
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
