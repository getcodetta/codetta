// Bookmarks sidebar panel — lists files the user has explicitly pinned
// via the file tree right-click menu or the tab star button.
//
// Companion to recentFiles.ts (the Ctrl+Tab move-to-front overlay):
//   - recents are auto-populated, ephemeral, and ranked by last access
//   - bookmarks are explicit, persistent, and ranked by add-time
//
// Click → open file. Right-side × removes from the list. Per-row
// optional note that the user can edit inline.

import { useEffect, useState } from "react";
import { useStore } from "../store";
import {
  loadBookmarks,
  removeBookmark,
  setBookmarkNote,
  subscribeBookmarks,
  type Bookmark,
} from "../bookmarks";
import { Icon } from "./Icon";
import { basename, relPath } from "../pathUtils";
import {
  confirm as dialogConfirm,
  prompt as dialogPrompt,
} from "../dialog";
import { info as toastInfo } from "../notify";

interface Props {
  wsId: string;
  root: string;
}

function formatRelative(ms: number): string {
  const ago = (Date.now() - ms) / 1000;
  if (ago < 60) return "just now";
  if (ago < 3600) return `${Math.floor(ago / 60)}m ago`;
  if (ago < 86400) return `${Math.floor(ago / 3600)}h ago`;
  if (ago < 86400 * 7) return `${Math.floor(ago / 86400)}d ago`;
  return new Date(ms).toLocaleDateString();
}

export function BookmarksPanel({ wsId, root }: Props) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>(() =>
    loadBookmarks(wsId),
  );

  // Subscribe to add/remove/rename so the panel stays in sync with the
  // file-tree right-click menu and the tab star button.
  useEffect(() => {
    const unsub = subscribeBookmarks((changedWsId) => {
      if (changedWsId === wsId) {
        setBookmarks(loadBookmarks(wsId));
      }
    });
    setBookmarks(loadBookmarks(wsId));
    return unsub;
  }, [wsId]);

  const onOpen = (b: Bookmark) => {
    void useStore.getState().openFile(wsId, b.path);
  };

  // No confirm for plain bookmarks: removal is one click to reverse
  // (re-pin from the tree or tab star) and the sibling line-bookmarks
  // panel already removes instantly. Bookmarks WITH a user-written note
  // still confirm — the note is destroyed with the bookmark and re-
  // pinning doesn't bring it back.
  const onRemove = async (b: Bookmark) => {
    if (b.note?.trim()) {
      const ok = await dialogConfirm(
        `Remove ${basename(b.path)} from bookmarks?\n\nIts note will be deleted too:\n"${b.note.slice(0, 200)}"`,
        { title: "Remove bookmark", okLabel: "Remove", danger: true },
      );
      if (!ok) return;
    }
    removeBookmark(wsId, b.path);
    toastInfo(`Removed bookmark ${basename(b.path)}`);
  };

  const onEditNote = async (b: Bookmark) => {
    const note = await dialogPrompt(
      "Note (optional)",
      b.note ?? "",
      { title: "Bookmark note", okLabel: "Save" },
    );
    if (note === null) return;
    setBookmarkNote(wsId, b.path, note);
  };

  return (
    <div className="bookmarks-panel">
      <div className="bookmarks-panel-header">
        <span>Bookmarks</span>
        {bookmarks.length > 0 && (
          <span className="bookmarks-count">{bookmarks.length}</span>
        )}
      </div>

      {bookmarks.length === 0 && (
        <div className="bookmarks-empty">
          No bookmarks yet. Right-click any file in the Explorer →{" "}
          <strong>Pin to bookmarks</strong>.
        </div>
      )}

      <div className="bookmarks-list">
        {bookmarks.map((b) => (
          <div key={b.path} className="bookmarks-row">
            <button
              className="bookmarks-row-main"
              onClick={() => onOpen(b)}
              title={b.path}
            >
              <Icon name="star-filled" size={11} className="bookmarks-star" />
              <div className="bookmarks-meta">
                <span className="bookmarks-name">{basename(b.path)}</span>
                <span className="bookmarks-rel">
                  {relPath(b.path, root) || b.path}
                </span>
                {b.note && (
                  <span className="bookmarks-note">{b.note}</span>
                )}
                <span className="bookmarks-time">
                  added {formatRelative(b.addedAt)}
                </span>
              </div>
            </button>
            <div className="bookmarks-actions">
              <button
                className="bookmarks-action"
                onClick={() => void onEditNote(b)}
                title="Edit note"
                aria-label={`Edit note for ${basename(b.path)}`}
              >
                <Icon name="edit" size={11} />
              </button>
              <button
                className="bookmarks-action bookmarks-action-danger"
                onClick={() => void onRemove(b)}
                title="Remove bookmark"
                aria-label={`Remove ${basename(b.path)} from bookmarks`}
              >
                <Icon name="x" size={11} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
