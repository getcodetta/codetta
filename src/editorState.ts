import { useEffect, useState } from "react";
import type { editor } from "monaco-editor";

// ---- Active Monaco editor instance (so app-level shortcuts / commands
//      can reach into the focused editor without prop drilling). ----
let _activeEditor: editor.IStandaloneCodeEditor | null = null;
export function setActiveEditor(ed: editor.IStandaloneCodeEditor | null) {
  _activeEditor = ed;
}
export function getActiveEditor(): editor.IStandaloneCodeEditor | null {
  return _activeEditor;
}

export interface EditorState {
  filePath: string | null;
  language: string | null;
  line: number;
  col: number;
  selectionText: string;
  selectionLines: number;
}

const initial: EditorState = {
  filePath: null,
  language: null,
  line: 1,
  col: 1,
  selectionText: "",
  selectionLines: 0,
};

let _state: EditorState = initial;
const listeners = new Set<(s: EditorState) => void>();

function notify() {
  for (const l of listeners) l(_state);
}

export function setEditorState(patch: Partial<EditorState>) {
  _state = { ..._state, ...patch };
  notify();
}

export function clearEditorState() {
  if (
    _state.filePath === null &&
    _state.language === null &&
    _state.line === 1 &&
    _state.col === 1 &&
    _state.selectionText === "" &&
    _state.selectionLines === 0
  )
    return;
  _state = { ...initial };
  notify();
}

export function useEditorState(): EditorState {
  const [s, setS] = useState(_state);
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

// One-shot "goto" event used by panels (search, todos) to jump the editor
// to a specific line/column once the file has been opened.
type GotoListener = (pos: { line: number; col: number }) => void;
const gotoListeners = new Set<GotoListener>();
let pendingGoto: { line: number; col: number } | null = null;

export function setEditorGoto(line: number, col: number) {
  const pos = { line, col };
  if (gotoListeners.size === 0) {
    // No editor mounted yet — stash for the next subscriber.
    pendingGoto = pos;
  }
  for (const l of gotoListeners) l(pos);
}

export function onEditorGoto(cb: GotoListener): () => void {
  gotoListeners.add(cb);
  if (pendingGoto) {
    const p = pendingGoto;
    pendingGoto = null;
    queueMicrotask(() => cb(p));
  }
  return () => gotoListeners.delete(cb);
}

// Lightweight pub/sub for "open a diff view" requests originating outside
// the editor area (e.g., the source-control panel).
export interface DiffRequest {
  path: string;
  refspec: string;
  originalContent: string;
  modifiedContent: string;
  language: string;
}
type DiffListener = (req: DiffRequest) => void;
const diffListeners = new Set<DiffListener>();
export function requestDiff(req: DiffRequest) {
  for (const l of diffListeners) l(req);
}
export function onDiffRequest(cb: DiffListener): () => void {
  diffListeners.add(cb);
  return () => diffListeners.delete(cb);
}
