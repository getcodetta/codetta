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
  setActiveEditor,
} from "../editorState";
import { useEditorSettings } from "../editorSettings";
import { fs, git as gitApi } from "../ipc";
import { fsBus, pathsEqual } from "../fsBus";
import { warning } from "../notify";
import { pushRecentFile } from "../recentFiles";
import { confirm as dialogConfirm } from "../dialog";

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

const extToLang: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  rs: "rust",
  py: "python",
  html: "html",
  css: "css",
  scss: "scss",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  sh: "shell",
  ps1: "powershell",
  sql: "sql",
  xml: "xml",
};

function langOf(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && extToLang[m[1]]) || "plaintext";
}

function dirname(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  return i > 0 ? norm.slice(0, i) : norm;
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
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<Monaco | null>(null);
  const decorationsRef = useRef<editor.IEditorDecorationsCollection | null>(
    null,
  );
  const [previewOpen, setPreviewOpen] = useState(false);

  const language = file ? langOf(path) : null;
  const isMarkdown = language === "markdown";

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
    file,
  ]);

  useEffect(() => {
    setEditorState({ filePath: path, language });
    pushRecentFile(wsId, path);
    return () => {
      clearEditorState();
    };
  }, [path, language, wsId]);

  // External-file-change detection: when the watcher reports the parent
  // directory changed, check if our file is dirty in memory and ALSO has
  // a different on-disk content. Prompt to reload.
  useEffect(() => {
    if (!file) return;
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
            useStore.getState().updateFileContents(wsId, path, onDisk);
            useStore
              .getState()
              .loaded[wsId]?.files[path] &&
              (useStore.setState((s) => {
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
              }));
            return;
          }
          // Dirty — prompt.
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
  }, [wsId, path, file]);

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
      {isMarkdown && (
        <button
          className={`editor-preview-toggle ${previewOpen ? "active" : ""}`}
          onClick={() => setPreviewOpen((v) => !v)}
          title="Toggle Markdown preview"
        >
          {previewOpen ? "✎ Edit only" : "👁 Preview"}
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
        }}
        onMount={(ed: editor.IStandaloneCodeEditor, monaco: Monaco) => {
          editorRef.current = ed;
          monacoRef.current = monaco;
          setActiveEditor(ed);
          ed.onDidFocusEditorWidget(() => setActiveEditor(ed));
          ed.onDidChangeCursorPosition((e) => {
            setEditorState({
              line: e.position.lineNumber,
              col: e.position.column,
            });
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
          ed.onDidDispose(() => {
            off();
            setActiveEditor(null);
          });
        }}
        onChange={(v) => update(wsId, path, v ?? "")}
      />
      </div>
      {isMarkdown && previewOpen && (
        <div className="preview-half">
          <MarkdownPreview content={file.contents} />
        </div>
      )}
    </div>
  );
}
