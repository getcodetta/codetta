// In-memory cache of Monaco editor view states (scroll position, cursor,
// selection, folded ranges) keyed by absolute file path. Lets a tab
// reopen with the same scroll/cursor it had when the user last
// navigated away — closing and reopening a file should resume where
// you left off, not slam you back to line 1.
//
// Why in-memory and not persisted: Monaco's view-state object is an
// opaque structure tied to the running editor's internals; serialising
// it across app restarts is brittle and the rare case where stale
// view state restores into a renamed/restructured file would be
// confusing. A session-scoped cache covers the common "tab close →
// tab reopen" workflow without the surprise.

import type { editor } from "monaco-editor";

const cache = new Map<string, editor.ICodeEditorViewState>();

export function saveViewState(
  path: string,
  state: editor.ICodeEditorViewState | null,
): void {
  if (!state) return;
  cache.set(path, state);
}

export function loadViewState(
  path: string,
): editor.ICodeEditorViewState | null {
  return cache.get(path) ?? null;
}

export function dropViewState(path: string): void {
  cache.delete(path);
}
