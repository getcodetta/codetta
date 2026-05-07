// File outline panel — sidebar list of symbols defined in the
// currently active editor file. Companion to the workspace-wide Go
// to Symbol palette mode (`@`): the palette is for "I want to jump
// somewhere across the project," this panel is for "what's IN the
// file I'm looking at."
//
// Backed by src/fileOutline.ts (pure regex extractor) so we don't
// round-trip through Rust on every keystroke. Re-extracts when the
// file path or the active buffer's contents change.

import { useMemo, useState, useEffect } from "react";
import { useStore } from "../store";
import { useEditorState } from "../editorState";
import { setEditorGoto } from "../editorState";
import { extractFileOutline, type OutlineSymbol } from "../fileOutline";
import { Icon, type IconName } from "./Icon";
import { basename } from "../pathUtils";

interface Props {
  wsId: string;
  // root is unused here but kept in the SidebarStack contract so the
  // signature matches the other sidebar panels.
  root: string;
}

// Map symbol kinds to icons. Keep the same vocabulary as the Rust
// find_symbols command + chatToolRender's tool icons so the visual
// language is consistent across surfaces.
const KIND_ICON: Record<string, IconName> = {
  function: "wrench",
  fn: "wrench",
  func: "wrench",
  def: "wrench",
  method: "wrench",
  class: "command",
  interface: "code",
  type: "code",
  enum: "check-square",
  struct: "code",
  trait: "code",
  impl: "code",
  const: "circle",
  var: "circle",
  let: "circle",
  // Markdown headings use a single icon — depth is encoded by the
  // existing tree-style indentation in the panel, so an h1/h2/h3
  // distinction here would just add visual noise.
  h1: "hash",
  h2: "hash",
  h3: "hash",
  h4: "hash",
  h5: "hash",
  h6: "hash",
};

function iconForKind(kind: string): IconName {
  return KIND_ICON[kind] ?? "file-text";
}

export function OutlinePanel({ wsId, root: _root }: Props) {
  const editorState = useEditorState();
  const filePath = editorState.filePath;
  const fileContents = useStore((s) => {
    if (!filePath || !wsId) return null;
    return s.loaded[wsId]?.files[filePath]?.contents ?? null;
  });
  const [filter, setFilter] = useState("");

  // Reset the filter when the active file switches — a stale "useState"
  // filter from one file applied to another's outline is just confusing.
  useEffect(() => {
    setFilter("");
  }, [filePath]);

  const symbols = useMemo(() => {
    if (!filePath || fileContents == null) return [];
    return extractFileOutline(filePath, fileContents);
  }, [filePath, fileContents]);

  const filtered = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return symbols;
    return symbols.filter(
      (s) => s.name.toLowerCase().includes(q) || s.kind.toLowerCase().includes(q),
    );
  }, [symbols, filter]);

  const onClick = (sym: OutlineSymbol) => {
    setEditorGoto(sym.line, 1);
  };

  return (
    <div className="outline-panel">
      <div className="outline-panel-header">
        {filePath ? (
          <span className="outline-panel-file" title={filePath}>
            {basename(filePath)}
          </span>
        ) : (
          <span className="outline-panel-empty-hint">No file open</span>
        )}
        {symbols.length > 0 && (
          <span className="outline-panel-count">
            {filter ? `${filtered.length}/${symbols.length}` : symbols.length}
          </span>
        )}
      </div>

      {symbols.length > 0 && (
        <div className="outline-panel-filter">
          <input
            type="text"
            placeholder="Filter symbols…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter outline symbols"
          />
          {filter && (
            <button
              className="outline-panel-filter-clear"
              onClick={() => setFilter("")}
              title="Clear filter"
              aria-label="Clear filter"
            >
              <Icon name="x" size={11} />
            </button>
          )}
        </div>
      )}

      {filePath && symbols.length === 0 && (
        <div className="outline-panel-empty">
          No symbols found. Outline supports TypeScript, JavaScript,
          Rust, Python, and Go. Other languages render empty.
        </div>
      )}

      {filtered.length === 0 && symbols.length > 0 && (
        <div className="outline-panel-empty">No matches for “{filter}”.</div>
      )}

      <div className="outline-panel-list">
        {filtered.map((sym, i) => (
          <button
            key={`${sym.line}:${sym.name}:${i}`}
            className="outline-panel-row"
            style={{ paddingLeft: 8 + Math.min(sym.depth, 6) * 12 }}
            onClick={() => onClick(sym)}
            title={`${sym.kind} · line ${sym.line}`}
          >
            <span className="outline-panel-icon">
              <Icon name={iconForKind(sym.kind)} size={11} />
            </span>
            <span className="outline-panel-name">{sym.name}</span>
            <span className="outline-panel-line">{sym.line}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
