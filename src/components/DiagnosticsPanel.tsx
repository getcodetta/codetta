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

// Border / accent colors for the severity filter chips. Kept inline so
// this file stays self-contained and doesn't require an App.css edit.
const SEVERITY_COLOR: Record<DiagnosticEntry["severity"], string> = {
  error: "#f14c4c",
  warning: "#cca700",
  info: "var(--accent)",
  hint: "var(--fg-muted)",
};

const SEVERITY_ORDER: DiagnosticEntry["severity"][] = [
  "error",
  "warning",
  "info",
  "hint",
];

const SEVERITY_LABEL: Record<DiagnosticEntry["severity"], string> = {
  error: "Errors",
  warning: "Warnings",
  info: "Info",
  hint: "Hints",
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
  // Severities the user has toggled OFF. Default empty = everything visible.
  const [hiddenSev, setHiddenSev] = useState<
    Set<DiagnosticEntry["severity"]>
  >(() => new Set());

  useEffect(() => {
    const unsub = subscribeDiagnostics(setEntries);
    // Pull a fresh snapshot in case markers landed between mount and
    // subscribe — getDiagnostics() also kicks the lazy Monaco wire-up.
    setEntries(getDiagnostics());
    return unsub;
  }, []);

  // Per-severity counts come from the unfiltered entries so chip badges
  // and the header counts always reflect reality (the filter only hides
  // rows in the list below).
  const sevCounts = useMemo(() => {
    const c: Record<DiagnosticEntry["severity"], number> = {
      error: 0,
      warning: 0,
      info: 0,
      hint: 0,
    };
    for (const e of entries) c[e.severity]++;
    return c;
  }, [entries]);

  // Apply the severity filter, then group. Empty groups (all rows hidden)
  // are dropped so we don't render bare file headers.
  const groups = useMemo(() => {
    const visible = entries.filter((e) => !hiddenSev.has(e.severity));
    return groupByFile(visible);
  }, [entries, hiddenSev]);

  const errorCount = sevCounts.error;
  const warningCount = sevCounts.warning;
  const totalVisible = entries.length - (
    (hiddenSev.has("error") ? sevCounts.error : 0) +
    (hiddenSev.has("warning") ? sevCounts.warning : 0) +
    (hiddenSev.has("info") ? sevCounts.info : 0) +
    (hiddenSev.has("hint") ? sevCounts.hint : 0)
  );

  const toggleSev = (sev: DiagnosticEntry["severity"]) => {
    setHiddenSev((prev) => {
      const next = new Set(prev);
      if (next.has(sev)) next.delete(sev);
      else next.add(sev);
      return next;
    });
  };

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

      {entries.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 6,
            padding: "6px 10px",
            borderBottom: "1px solid var(--border)",
          }}
        >
          {SEVERITY_ORDER.map((sev) => {
            const active = !hiddenSev.has(sev);
            const color = SEVERITY_COLOR[sev];
            return (
              <button
                key={sev}
                type="button"
                onClick={() => toggleSev(sev)}
                title={
                  active
                    ? `Hide ${SEVERITY_LABEL[sev].toLowerCase()}`
                    : `Show ${SEVERITY_LABEL[sev].toLowerCase()}`
                }
                aria-pressed={active}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "2px 8px",
                  borderRadius: 999,
                  border: `1px solid ${active ? color : "var(--border)"}`,
                  background: active ? `${color}22` : "transparent",
                  color: active ? "var(--fg)" : "var(--fg-muted)",
                  font: "inherit",
                  fontSize: 11,
                  lineHeight: 1.4,
                  cursor: "pointer",
                  opacity: active ? 1 : 0.7,
                }}
              >
                <Icon name={SEVERITY_ICON[sev]} size={11} />
                <span>{SEVERITY_LABEL[sev]}</span>
                <span
                  style={{
                    fontVariantNumeric: "tabular-nums",
                    opacity: 0.85,
                  }}
                >
                  {sevCounts[sev]}
                </span>
              </button>
            );
          })}
        </div>
      )}

      {entries.length === 0 && (
        <div className="diagnostics-empty">
          No problems detected. Markers come from Monaco's language services
          (TypeScript / JavaScript out of the box).
        </div>
      )}

      {entries.length > 0 && totalVisible === 0 && (
        <div className="diagnostics-empty">
          All {entries.length} problem{entries.length === 1 ? "" : "s"} hidden
          by filters.
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
