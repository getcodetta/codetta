import Editor, { type Monaco } from "@monaco-editor/react";
import { useEffect, useRef, useState } from "react";
import type { editor } from "monaco-editor";
import { useStore } from "../store";
import { useResolvedTheme } from "../theme";
import { MarkdownPreview } from "./MarkdownPreview";
import {
  setEditorState,
  clearEditorState,
  onEditorGoto,
  requestMdPreviewScroll,
  setActiveEditor,
} from "../editorState";
import { useEditorSettings } from "../editorSettings";
import { fs, git as gitApi } from "../ipc";
import { fsBus, pathsEqual } from "../fsBus";
import { warning } from "../notify";
import { pushRecentFile } from "../recentFiles";
import { confirm as dialogConfirm } from "../dialog";
import { langOf } from "../langDetect";
import { dirname } from "../pathUtils";
import { Icon } from "./Icon";
import { EditorBreadcrumbs } from "./EditorBreadcrumbs";
import { requestAIPrompt } from "../aiBus";

// Right-click "Ask AI to …" actions registered with Monaco. Each one
// grabs the current selection (or the whole file when nothing is
// selected) and ships a pre-composed prompt to the active AI chat
// panel via the aiBus. They're cheap, lazily registered, and only
// active for the focused editor — matching the way users already think
// about per-pane chrome.
interface AIAction {
  id: string;
  label: string;
  prompt: string;
}
const AI_ACTIONS: AIAction[] = [
  {
    id: "askAI.explain",
    label: "Ask AI to explain",
    prompt: "Explain what this code does, step by step.",
  },
  {
    id: "askAI.refactor",
    label: "Ask AI to refactor",
    prompt:
      "Suggest a refactor that improves readability or correctness. Show the proposed change as a diff.",
  },
  {
    id: "askAI.fix",
    label: "Ask AI to find bugs",
    prompt:
      "Review this code for bugs, edge cases, and likely failure modes. Propose concrete fixes.",
  },
  {
    id: "askAI.test",
    label: "Ask AI to write tests",
    prompt:
      "Write tests for this code. Cover the golden path plus the obvious edge cases.",
  },
  {
    id: "askAI.docs",
    label: "Ask AI to add docs",
    prompt:
      "Add concise documentation comments to this code. Keep them grounded in what the code does, not aspirational descriptions.",
  },
];

interface GitChangeRange {
  kind: "added" | "modified" | "deleted";
  startLine: number;
  endLine: number;
}

function parseDiffHunks(diff: string): GitChangeRange[] {
  const out: GitChangeRange[] = [];
  if (!diff) return out;
  const lines = diff.split("\n");
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (!m) {
      i++;
      continue;
    }
    let newLine = parseInt(m[1], 10);
    i++;
    let buffer: { startLine: number; hasRemove: boolean } | null = null;
    let pendingRemove = false;
    while (
      i < lines.length &&
      !lines[i].startsWith("@@") &&
      !lines[i].startsWith("diff ") &&
      !lines[i].startsWith("--- ") &&
      !lines[i].startsWith("+++ ")
    ) {
      const line = lines[i];
      const c = line[0];
      if (c === "+") {
        if (!buffer)
          buffer = { startLine: newLine, hasRemove: pendingRemove };
        newLine++;
        pendingRemove = false;
      } else if (c === "-") {
        if (buffer) {
          out.push({
            kind: buffer.hasRemove ? "modified" : "added",
            startLine: buffer.startLine,
            endLine: newLine - 1,
          });
          buffer = null;
        }
        pendingRemove = true;
      } else if (c === " ") {
        if (buffer) {
          out.push({
            kind: buffer.hasRemove ? "modified" : "added",
            startLine: buffer.startLine,
            endLine: newLine - 1,
          });
          buffer = null;
        }
        if (pendingRemove) {
          out.push({
            kind: "deleted",
            startLine: newLine,
            endLine: newLine,
          });
          pendingRemove = false;
        }
        newLine++;
      }
      i++;
    }
    if (buffer) {
      out.push({
        kind: buffer.hasRemove ? "modified" : "added",
        startLine: buffer.startLine,
        endLine: newLine - 1,
      });
    }
    if (pendingRemove) {
      out.push({
        kind: "deleted",
        startLine: Math.max(1, newLine - 1),
        endLine: Math.max(1, newLine - 1),
      });
    }
  }
  return out;
}

// Replace both `contents` and `original` for an open file with the given
// disk content, atomically. Used after a confirmed reload-from-disk so
// the editor view AND the dirty-tracker both move in lockstep — setting
// only one would either leave the buffer "dirty" against itself or
// silently flag the on-disk content as unsaved.
function replaceFileFromDisk(wsId: string, path: string, onDisk: string) {
  useStore.setState((s) => {
    const w = s.loaded[wsId];
    if (!w || !w.files[path]) return s;
    return {
      loaded: {
        ...s.loaded,
        [wsId]: {
          ...w,
          files: {
            ...w.files,
            [path]: {
              ...w.files[path],
              contents: onDisk,
              original: onDisk,
            },
          },
        },
      },
    };
  });
}

interface Props {
  wsId: string;
  path: string;
}

export function EditorPane({ wsId, path }: Props) {
  const file = useStore((s) => s.loaded[wsId]?.files[path]);
  const update = useStore((s) => s.updateFileContents);
  const resolvedTheme = useResolvedTheme();
  const settings = useEditorSettings();
  const wsRoot = useStore((s) => s.loaded[wsId]?.meta.root ?? "");
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(
    null,
  );
  const [previewOpen, setPreviewOpen] = useState(false);
  // Mirror of "the markdown split preview is currently active" so the
  // editor's scroll listener (registered once in onMount) can read
  // the current value without re-registering on every state change.
  const mdSplitActiveRef = useRef(false);

  const language = file ? langOf(path) : null;
  const isMarkdown = language === "markdown";
  // Keep the scroll-sync mirror updated so the onMount listener sees
  // the current state without needing to re-register.
  useEffect(() => {
    mdSplitActiveRef.current = isMarkdown && previewOpen;
  }, [isMarkdown, previewOpen]);

  // Apply runtime settings changes (font size, word wrap) without remounting.
  useEffect(() => {
    if (!editorRef.current) return;
    editorRef.current.updateOptions({
      fontSize: settings.fontSize,
      wordWrap: settings.wordWrap,
      tabSize: settings.tabSize,
      minimap: { enabled: settings.minimap },
    });
  }, [
    settings.fontSize,
    settings.wordWrap,
    settings.tabSize,
    settings.minimap,
  ]);

  // Auto-save: debounce-save when contents change while auto-save is on.
  // file?.contents and file?.original already cover every relevant
  // change — the bare `file` was a redundant duplicate (Zustand spreads
  // a new file object on every contents update).
  useEffect(() => {
    if (!settings.autoSave || !file) return;
    if (file.contents === file.original) return;
    const t = window.setTimeout(() => {
      void useStore.getState().saveFile(wsId, path);
    }, settings.autoSaveDelayMs);
    return () => window.clearTimeout(t);
  }, [
    settings.autoSave,
    settings.autoSaveDelayMs,
    file?.contents,
    file?.original,
    wsId,
    path,
  ]);

  useEffect(() => {
    setEditorState({ filePath: path, language });
    pushRecentFile(wsId, path);
    // Mark the file as "just touched" so the idle-buffer sweeper knows
    // someone is paying attention to it. The sweeper resets to "now"
    // again on focus + cursor moves below; this mount call covers the
    // common case where the user opens a tab and then walks away
    // without ever bringing focus to the editor body.
    useStore.getState().touchFile(wsId, path);
    return () => {
      clearEditorState();
    };
  }, [path, language, wsId]);

  // External-file-change detection: when the watcher reports the parent
  // directory changed, check if our file is dirty in memory and ALSO has
  // a different on-disk content. Prompt to reload.
  //
  // Dependency note: we deliberately omit `file` from the deps array.
  // Including it caused this effect to tear down + re-register the dir
  // listener on every keystroke (file.contents mutates on each
  // updateFileContents). Reads inside the handler go through
  // useStore.getState(), so there's no stale-closure risk. The component
  // returns null at the bottom when file is undefined, which natural-
  // unmount-cleans the effect via React's normal lifecycle.
  useEffect(() => {
    let canceled = false;
    let pendingTimer: number | null = null;

    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as {
        wsId: string;
        dir: string;
      };
      if (detail.wsId !== wsId) return;
      if (!pathsEqual(detail.dir, dirname(path))) return;
      if (pendingTimer) window.clearTimeout(pendingTimer);
      pendingTimer = window.setTimeout(async () => {
        if (canceled) return;
        try {
          const onDisk = await fs.readFile(path);
          const cur = useStore.getState().loaded[wsId]?.files[path];
          if (!cur) return;
          if (onDisk === cur.contents) return;
          if (cur.contents === cur.original) {
            // Not dirty — silently reload from disk.
            replaceFileFromDisk(wsId, path, onDisk);
            return;
          }
          // Dirty — prompt before clobbering the user's edits.
          const ok = await dialogConfirm(
            `${path}\n\nThis file changed on disk while you have unsaved edits. Reload from disk and discard your changes?`,
            {
              title: "File changed on disk",
              okLabel: "Reload",
              cancelLabel: "Keep mine",
              danger: true,
            },
          );
          if (ok && !canceled) {
            replaceFileFromDisk(wsId, path, onDisk);
          }
        } catch {
          warning(`File no longer accessible: ${path}`);
        }
      }, 200);
    };
    fsBus.addEventListener("dir", handler);
    return () => {
      canceled = true;
      fsBus.removeEventListener("dir", handler);
      if (pendingTimer) window.clearTimeout(pendingTimer);
    };
  }, [wsId, path]);

  // Inline git gutter: poll git diff and apply line decorations.
  useEffect(() => {
    if (!file) return;
    let cancelled = false;
    let debounce: number | null = null;

    const computeAndApply = async () => {
      const ed = editorRef.current;
      const m = monacoRef.current;
      if (!ed || !m) return;
      const wsRoot = useStore.getState().loaded[wsId]?.meta.root;
      if (!wsRoot) return;
      const root = wsRoot.replace(/\\/g, "/").replace(/\/+$/, "");
      const norm = path.replace(/\\/g, "/");
      if (!norm.startsWith(root + "/")) return;
      const rel = norm.slice(root.length + 1);
      let diff = "";
      try {
        diff = await gitApi.diff(wsRoot, rel);
      } catch {
        return; // not a git repo, or other error — skip silently
      }
      if (cancelled) return;
      const ranges = parseDiffHunks(diff);
      const decos: editor.IModelDeltaDecoration[] = ranges.map((r) => ({
        range: new m.Range(r.startLine, 1, r.endLine, 1),
        options: {
          isWholeLine: true,
          linesDecorationsClassName: `git-gutter git-gutter-${r.kind}`,
        },
      }));
      if (!decorationsRef.current) {
        decorationsRef.current = ed.createDecorationsCollection(decos);
      } else {
        decorationsRef.current.set(decos);
      }
    };

    const schedule = () => {
      if (debounce) window.clearTimeout(debounce);
      debounce = window.setTimeout(() => {
        debounce = null;
        void computeAndApply();
      }, 300);
    };

    schedule();

    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as {
        wsId: string;
        dir: string;
      };
      if (detail.wsId !== wsId) return;
      const fileDir = dirname(path);
      // Re-check on changes near our file or to .git (HEAD/index moved).
      if (
        pathsEqual(detail.dir, fileDir) ||
        detail.dir.replace(/\\/g, "/").endsWith("/.git")
      ) {
        schedule();
      }
    };
    fsBus.addEventListener("dir", handler);

    return () => {
      cancelled = true;
      fsBus.removeEventListener("dir", handler);
      if (debounce) window.clearTimeout(debounce);
      decorationsRef.current?.clear();
      decorationsRef.current = null;
    };
  }, [file?.original, wsId, path]);

  if (!file) return null;

  return (
    <div
      className={`editor-host ${
        isMarkdown && previewOpen ? "editor-host-split" : ""
      }`}
    >
      <EditorBreadcrumbs wsId={wsId} root={wsRoot} path={path} />
      {isMarkdown && (
        <button
          className={`editor-preview-toggle ${previewOpen ? "active" : ""}`}
          onClick={() => setPreviewOpen((v) => !v)}
          title="Toggle Markdown preview"
          aria-label="Toggle Markdown preview"
          aria-pressed={previewOpen}
        >
          <Icon name={previewOpen ? "edit" : "eye"} size={12} />
          <span>{previewOpen ? "Edit only" : "Preview"}</span>
        </button>
      )}
      <div className="editor-half">
      <Editor
        height="100%"
        path={path}
        language={language ?? "plaintext"}
        value={file.contents}
        theme={resolvedTheme === "dark" ? "vs-dark" : "vs"}
        options={{
          fontSize: settings.fontSize,
          minimap: { enabled: settings.minimap },
          scrollBeyondLastLine: false,
          tabSize: settings.tabSize,
          renderWhitespace: "selection",
          smoothScrolling: true,
          automaticLayout: true,
          wordWrap: settings.wordWrap,
          stickyScroll: { enabled: true },
          bracketPairColorization: { enabled: true },
          guides: {
            bracketPairs: "active",
            indentation: true,
          },
          mouseWheelZoom: true,
          cursorBlinking: "smooth",
          cursorSmoothCaretAnimation: "on",
          padding: { top: 8 },
          rulers: settings.rulers,
        }}
        onMount={(ed: editor.IStandaloneCodeEditor, monaco: Monaco) => {
          editorRef.current = ed;
          monacoRef.current = monaco;
          setActiveEditor(ed);
          ed.onDidFocusEditorWidget(() => {
            setActiveEditor(ed);
            useStore.getState().touchFile(wsId, path);
          });
          ed.onDidChangeCursorPosition((e) => {
            setEditorState({
              line: e.position.lineNumber,
              col: e.position.column,
            });
            useStore.getState().touchFile(wsId, path);
          });
          ed.onDidChangeCursorSelection(() => {
            const sel = ed.getSelection();
            const model = ed.getModel();
            if (!sel || !model || sel.isEmpty()) {
              setEditorState({ selectionText: "", selectionLines: 0 });
              return;
            }
            const text = model.getValueInRange(sel);
            const lines =
              sel.endLineNumber - sel.startLineNumber + 1;
            setEditorState({ selectionText: text, selectionLines: lines });
          });
          const off = onEditorGoto(({ line, col }) => {
            try {
              ed.revealPositionInCenter({ lineNumber: line, column: col });
              ed.setPosition({ lineNumber: line, column: col });
              ed.focus();
            } catch {
              /* ignore */
            }
          });
          // Editor → preview scroll-sync: when the user scrolls the
          // markdown editor in split mode, push the topmost visible
          // source line to the preview so it follows along. We only
          // dispatch when the split preview is currently active —
          // editing a markdown file with the preview hidden produces
          // a noisy stream of bus events otherwise. mdSplitActiveRef
          // gives us the up-to-date flag without rebinding the
          // listener every time the state changes.
          const offScroll = ed.onDidScrollChange(() => {
            if (!mdSplitActiveRef.current) return;
            try {
              const ranges = ed.getVisibleRanges();
              const top = ranges[0]?.startLineNumber ?? 1;
              requestMdPreviewScroll(top);
            } catch {
              /* ignore */
            }
          });
          // Register right-click "Ask AI to …" actions. They live in
          // their own context-menu group so they're visually grouped
          // under one section header, separated from Monaco's
          // built-ins. We also bind Cmd/Ctrl+I to "explain" since it's
          // the highest-frequency action.
          const disposables = AI_ACTIONS.map((action, idx) =>
            ed.addAction({
              id: action.id,
              label: action.label,
              contextMenuGroupId: "askai",
              contextMenuOrder: idx,
              keybindings:
                action.id === "askAI.explain"
                  ? [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyI]
                  : undefined,
              run: (editor) => {
                const model = editor.getModel();
                if (!model) return;
                const sel = editor.getSelection();
                let snippet: string;
                if (sel && !sel.isEmpty()) {
                  snippet = model.getValueInRange(sel);
                } else {
                  snippet = model.getValue();
                }
                if (!snippet.trim()) return;
                const lang = model.getLanguageId() || "";
                const filename = path.split(/[\\/]/).pop() || path;
                const text = `${action.prompt}\n\n\`\`\`${lang} ${filename}\n${snippet}\n\`\`\``;
                // Make sure the chat panel is mounted (it ignores bus
                // events if hidden because it isn't listening). Toggle
                // visibility then schedule the dispatch a frame later
                // so the panel has a chance to subscribe.
                const store = useStore.getState();
                if (!store.loaded[wsId]?.layout?.aiPanelVisible) {
                  store.setAIPanelVisible(wsId, true);
                }
                requestAnimationFrame(() => {
                  requestAIPrompt({ wsId, text, send: true });
                });
              },
            }),
          );
          ed.onDidDispose(() => {
            off();
            offScroll.dispose();
            for (const d of disposables) d.dispose();
            setActiveEditor(null);
          });
        }}
        onChange={(v) => update(wsId, path, v ?? "")}
      />
      </div>
      {isMarkdown && previewOpen && (
        <div className="preview-half">
          <MarkdownPreview content={file.contents} interactive />
        </div>
      )}
    </div>
  );
}
