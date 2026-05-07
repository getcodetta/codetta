// Path + symbol breadcrumb shown at the top of the editor pane.
// Two segments separated by a divider:
//
//   workspace > src > components > Foo.tsx     ›   className › methodName
//   ↑ path                                          ↑ enclosing symbol
//
// The path segment makes file location obvious in deep trees without
// having to mentally parse the absolute path. The symbol segment
// (when applicable) shows the user where in the file their cursor
// currently sits, in the same vocabulary as the Outline panel and
// Go to Symbol palette.
//
// Source for symbols: extractFileOutline (the same pure regex extractor
// used by the Outline panel — keeps the visual language consistent).
// Source for cursor line: useEditorState — the same store the StatusBar
// reads "Ln 42, Col 8" from.

import { useMemo } from "react";
import { useStore } from "../store";
import { useEditorState } from "../editorState";
import { extractFileOutline } from "../fileOutline";
import { Icon } from "./Icon";

interface Props {
  wsId: string;
  root: string;
  /** Path of the file rendered by this specific editor pane. The
   *  global editorState tracks only the *focused* pane, so we pass
   *  the per-pane path explicitly to avoid showing the wrong path
   *  in unfocused split panes. */
  path: string;
}

function splitPathSegments(path: string, root: string): string[] {
  const norm = path.replace(/\\/g, "/");
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  if (norm.startsWith(r + "/")) {
    return norm
      .slice(r.length + 1)
      .split("/")
      .filter(Boolean);
  }
  // File outside the workspace root (e.g. tmpfile, network share).
  // Show just the last 3 segments so the bar isn't dominated by an
  // absolute path.
  const parts = norm.split("/").filter(Boolean);
  return parts.slice(-3);
}

export function EditorBreadcrumbs({ wsId, root, path }: Props) {
  const editorState = useEditorState();
  // Only trust the global cursor line when this pane is the focused one.
  // Otherwise the symbol portion would show whichever symbol the *other*
  // pane's cursor is in, which is misleading.
  const isFocused = editorState.filePath === path;
  const cursorLine = isFocused ? editorState.line : 0;
  const wsName = useStore((s) => s.loaded[wsId]?.meta.name ?? "");
  const fileContents = useStore((s) =>
    path && wsId ? s.loaded[wsId]?.files[path]?.contents ?? null : null,
  );

  const segments = useMemo(
    () => (path ? splitPathSegments(path, root) : []),
    [path, root],
  );

  // Walk the outline and pick the deepest symbol whose line is ≤
  // the cursor line. That's the one we're currently inside. Skip
  // when the file isn't outline-supported — the extractor returns
  // [] for unrecognised extensions. Skip entirely when this pane
  // isn't focused (cursorLine === 0).
  const symbolPath = useMemo(() => {
    if (!path || fileContents == null || !isFocused) return [];
    const symbols = extractFileOutline(path, fileContents);
    if (symbols.length === 0) return [];
    // Build the chain of enclosing symbols by walking the depth-stack:
    // for each symbol whose line ≤ cursor line, keep entries whose
    // depth is strictly less than this one's. Anything left at the
    // end of the walk is "still active" at the cursor — i.e., the
    // user is inside it.
    const stack: { depth: number; name: string; kind: string }[] = [];
    for (const s of symbols) {
      if (s.line > cursorLine) break;
      while (stack.length > 0 && stack[stack.length - 1].depth >= s.depth) {
        stack.pop();
      }
      stack.push({ depth: s.depth, name: s.name, kind: s.kind });
    }
    return stack;
  }, [path, fileContents, cursorLine, isFocused]);

  if (!path || segments.length === 0) {
    return null;
  }

  return (
    <div className="editor-breadcrumbs" role="navigation" aria-label="Breadcrumb">
      {wsName && (
        <span className="editor-breadcrumb-ws" title={`Workspace: ${wsName}`}>
          {wsName}
        </span>
      )}
      {segments.map((seg, i) => (
        <span key={`p:${i}`} className="editor-breadcrumb-row">
          <Icon
            name="chevron-right"
            size={10}
            className="editor-breadcrumb-sep"
          />
          <span
            className={
              i === segments.length - 1
                ? "editor-breadcrumb-leaf"
                : "editor-breadcrumb-seg"
            }
          >
            {seg}
          </span>
        </span>
      ))}
      {symbolPath.length > 0 && (
        <>
          <span
            className="editor-breadcrumb-divider"
            aria-hidden="true"
          />
          {symbolPath.map((s, i) => (
            <span key={`s:${i}`} className="editor-breadcrumb-row">
              <Icon
                name="chevron-right"
                size={10}
                className="editor-breadcrumb-sep"
              />
              <span
                className="editor-breadcrumb-symbol"
                title={`${s.kind} (${i === symbolPath.length - 1 ? "current" : "enclosing"})`}
              >
                {s.name}
              </span>
            </span>
          ))}
        </>
      )}
    </div>
  );
}
