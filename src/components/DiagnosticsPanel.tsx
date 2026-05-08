// Problems / diagnostics sidebar panel — flat list of every Monaco
// marker across every open model, grouped by file. Reads from
// src/diagnostics.ts (which subscribes to monaco.editor.onDidChangeMarkers)
// so we never touch EditorPane and never round-trip through Rust.
//
// LSP caveat: Monaco only ships TypeScript / JavaScript language services
// in-process, so other languages will report nothing here unless an LSP
// or marker provider is wired in separately.

import { useEffect, useMemo, useState } from "react";
import { useStore } from "../store";
import { setEditorGoto } from "../editorState";
import {
  getDiagnostics,
  subscribeDiagnostics,
  type DiagnosticEntry,
} from "../diagnostics";
import { Icon, type IconName } from "./Icon";
import { basename } from "../pathUtils";

interface Props {
  wsId: string;
  // root is unused but matches the sibling sidebar-panel signature.
  root: string;
}

// Severity sort weight (errors first within each file). Matches the
// MarkerSeverity int ordering so "error" surfaces above "warning"
// above "info" above "hint".
const SEVERITY_WEIGHT: Record<DiagnosticEntry["severity"], number> = {
  error: 4,
  warning: 3,
  info: 2,
  hint: 1,
};

const SEVERITY_ICON: Record<DiagnosticEntry["severity"], IconName> = {
  error: "x-circle",
  warning: "alert-triangle",
  info: "info",
  hint: "info",
};

const SEVERITY_CLASS: Record<DiagnosticEntry["severity"], string> = {
  error: "diagnostics-row-error",
  warning: "diagnostics-row-warning",
  info: "diagnostics-row-info",
  hint: "diagnostics-row-hint",
};

// Convert a Monaco URI string to a filesystem path the store can open.
// Monaco URIs typically come in as "file:///c:/foo/bar.ts" on Windows or
// "file:///home/u/foo.ts" on Unix; some are bare paths (inmemory:// or
// raw). Best effort: strip the scheme and decode percent-encoding.
function uriToPath(uri: string): string {
  let s = uri;
  if (s.startsWith("file://")) s = s.slice("file://".length);
  // Windows file URIs have a leading slash before the drive letter we
  // need to drop ("/c:/foo" → "c:/foo"). Unix paths legitimately start
  // with a slash, so we only strip when a drive-letter pattern follows.
  if (/^\/[a-zA-Z]:\//.test(s)) s = s.slice(1);
  try {
    s = decodeURIComponent(s);
  } catch {
    // Already decoded or contains an invalid escape — pass through.
  }
  return s;
}

interface FileGroup {
  path: string;
  rows: DiagnosticEntry[];
}

function groupByFile(entries: DiagnosticEntry[]): FileGroup[] {
  const map = new Map<string, DiagnosticEntry[]>();
  for (const e of entries) {
    const path = uriToPath(e.uri);
    const arr = map.get(path);
    if (arr) arr.push(e);
    else map.set(path, [e]);
  }
  const groups: FileGroup[] = [];
  for (const [path, rows] of map) {
    rows.sort((a, b) => {
      const w = SEVERITY_WEIGHT[b.severity] - SEVERITY_WEIGHT[a.severity];
      if (w !== 0) return w;
      if (a.line !== b.line) return a.line - b.line;
      return a.col - b.col;
    });
    groups.push({ path, rows });
  }
  // Files with errors first, then by basename for stability.
  groups.sort((a, b) => {
    const aHasErr = a.rows.some((r) => r.severity === "error") ? 1 : 0;
    const bHasErr = b.rows.some((r) => r.severity === "error") ? 1 : 0;
    if (aHasErr !== bHasErr) return bHasErr - aHasErr;
    return basename(a.path).localeCompare(basename(b.path));
  });
  return groups;
}

export function DiagnosticsPanel({ wsId, root: _root }: Props) {
  const [entries, setEntries] = useState<DiagnosticEntry[]>(() =>
    getDiagnostics(),
  );

  useEffect(() => {
    const unsub = subscribeDiagnostics(setEntries);
    // Pull a fresh snapshot in case markers landed between mount and
    // subscribe — getDiagnostics() also kicks the lazy Monaco wire-up.
    setEntries(getDiagnostics());
    return unsub;
  }, []);

  const groups = useMemo(() => groupByFile(entries), [entries]);

  const errorCount = entries.filter((e) => e.severity === "error").length;
  const warningCount = entries.filter((e) => e.severity === "warning").length;

  const onOpen = (path: string, line: number, col: number) => {
    void useStore
      .getState()
      .openFile(wsId, path)
      .then(() => {
        setEditorGoto(line, col);
      });
  };

  return (
    <div className="diagnostics-panel">
      <div className="diagnostics-panel-header">
        <span className="diagnostics-panel-title">Problems</span>
        <span className="diagnostics-panel-counts">
          <span
            className="diagnostics-count diagnostics-count-error"
            title={`${errorCount} error${errorCount === 1 ? "" : "s"}`}
          >
            <Icon name="x-circle" size={11} />
            {errorCount}
          </span>
          <span
            className="diagnostics-count diagnostics-count-warning"
            title={`${warningCount} warning${warningCount === 1 ? "" : "s"}`}
          >
            <Icon name="alert-triangle" size={11} />
            {warningCount}
          </span>
        </span>
      </div>

      {entries.length === 0 && (
        <div className="diagnostics-empty">
          No problems detected. Markers come from Monaco's language services
          (TypeScript / JavaScript out of the box).
        </div>
      )}

      <div className="diagnostics-list">
        {groups.map((g) => (
          <div key={g.path} className="diagnostics-group">
            <div
              className="diagnostics-group-header"
              title={g.path}
            >
              <span className="diagnostics-group-name">
                {basename(g.path) || g.path}
              </span>
              <span className="diagnostics-group-count">{g.rows.length}</span>
            </div>
            {g.rows.map((r, i) => (
              <button
                key={`${r.line}:${r.col}:${i}`}
                className={`diagnostics-row ${SEVERITY_CLASS[r.severity]}`}
                onClick={() => onOpen(g.path, r.line, r.col)}
                title={r.source ? `${r.source} — ${r.message}` : r.message}
              >
                <span className="diagnostics-row-icon">
                  <Icon name={SEVERITY_ICON[r.severity]} size={11} />
                </span>
                <span className="diagnostics-row-pos">
                  {r.line}:{r.col}
                </span>
                <span className="diagnostics-row-message">{r.message}</span>
                {r.source && (
                  <span className="diagnostics-row-source">{r.source}</span>
                )}
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
