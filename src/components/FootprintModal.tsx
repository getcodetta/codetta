import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { fileKey, useStore, type Pane } from "../store";
import { relPath } from "../pathUtils";
import { Icon } from "./Icon";

interface Props {
  open: boolean;
  onClose: () => void;
}

/**
 * Walk the pane tree and collect every leaf pane's currently-active tab
 * key. We use this to lock the "Unload" button on files that are visible
 * in some pane — unloading the active tab would yank the buffer the
 * editor is rendering.
 */
function collectActiveTabKeys(p: Pane | null, out: Set<string>): void {
  if (!p) return;
  if (p.kind === "tabs") {
    if (p.active) out.add(p.active);
    return;
  }
  collectActiveTabKeys(p.first, out);
  collectActiveTabKeys(p.second, out);
}

/**
 * Best-effort UTF-8 byte size of a buffer's contents. Uses the Blob ctor
 * because it does the encoding for us — fine for an at-a-glance diagnostic
 * even if the on-disk file uses a different encoding (we'd never round-
 * trip those bytes anyway, this is just to size the in-memory hit).
 */
function utf8Bytes(s: string): number {
  return new Blob([s]).size;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MiB`;
}

export function FootprintModal({ open, onClose }: Props) {
  const wsId = useStore((s) => s.activeId);
  const ws = useStore((s) => (s.activeId ? s.loaded[s.activeId] : null));

  const [fileFilter, setFileFilter] = useState("");
  const [termFilter, setTermFilter] = useState("");

  // Esc to close — same convention as SettingsModal.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Reset filters every time the modal reopens so a stale search from a
  // previous visit doesn't hide everything by default.
  useEffect(() => {
    if (open) {
      setFileFilter("");
      setTermFilter("");
    }
  }, [open]);

  // Pre-compute the set of "currently-visible" tab keys. The unload button
  // must be locked for any file whose key is the active tab in *any* pane.
  const activeKeys = useMemo(() => {
    const acc = new Set<string>();
    if (ws) {
      collectActiveTabKeys(ws.layout.editorRoot, acc);
      collectActiveTabKeys(ws.layout.bottomRoot, acc);
    }
    return acc;
  }, [ws]);

  const fileRows = useMemo(() => {
    if (!ws) return [] as Array<{
      path: string;
      rel: string;
      bytes: number;
      dirty: boolean;
      active: boolean;
    }>;
    const root = ws.meta.root;
    const filterLow = fileFilter.trim().toLowerCase();
    const rows = Object.entries(ws.files).map(([path, f]) => {
      const rel = relPath(path, root);
      const bytes = utf8Bytes(f.contents);
      const dirty = f.contents !== f.original;
      const active = activeKeys.has(fileKey(path));
      return { path, rel, bytes, dirty, active };
    });
    const filtered = filterLow
      ? rows.filter((r) => r.rel.toLowerCase().includes(filterLow))
      : rows;
    filtered.sort((a, b) => b.bytes - a.bytes);
    return filtered;
  }, [ws, fileFilter, activeKeys]);

  const termRows = useMemo(() => {
    if (!ws) return [] as Array<{
      id: string;
      title: string;
      popped: boolean;
    }>;
    const filterLow = termFilter.trim().toLowerCase();
    const rows = Object.values(ws.terminals).map((t) => ({
      id: t.id,
      title: t.title,
      popped: t.popped === true,
    }));
    const filtered = filterLow
      ? rows.filter((r) => r.title.toLowerCase().includes(filterLow))
      : rows;
    filtered.sort((a, b) => a.title.localeCompare(b.title));
    return filtered;
  }, [ws, termFilter]);

  const totalBytes = useMemo(
    () => Object.values(ws?.files ?? {}).reduce(
      (acc, f) => acc + utf8Bytes(f.contents),
      0,
    ),
    [ws],
  );

  if (!open) return null;

  const handleUnload = (path: string) => {
    if (!wsId) return;
    // The store exposes unloadIdleFile only on builds that ship the file
    // sweeper. Reach for it dynamically so a worktree without the sweeper
    // still type-checks; if it's absent, the button stays disabled below
    // and this branch never runs.
    const st = useStore.getState() as unknown as {
      unloadIdleFile?: (wsId: string, path: string) => void;
    };
    st.unloadIdleFile?.(wsId, path);
  };

  const handleCloseTerminal = (id: string) => {
    if (!wsId) return;
    useStore.getState().closeTerminal(wsId, id);
  };

  const hasUnloadFn =
    typeof (useStore.getState() as unknown as Record<string, unknown>)
      .unloadIdleFile === "function";

  return createPortal(
    <div className="settings-backdrop" onMouseDown={onClose}>
      <div
        className="settings-modal shortcut-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="footprint-modal-title"
      >
        <div className="settings-header">
          <span id="footprint-modal-title">Workspace Footprint</span>
          <button
            className="settings-close"
            onClick={onClose}
            title="Close (Esc)"
            aria-label="Close footprint"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="settings-body" style={{ padding: "12px 18px" }}>
          {!ws ? (
            <div style={{ color: "var(--fg-muted)", fontSize: 13 }}>
              No active workspace.
            </div>
          ) : (
            <>
              <section style={{ marginBottom: 18 }}>
                <header
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    marginBottom: 8,
                    gap: 12,
                  }}
                >
                  <strong style={{ fontSize: 13 }}>
                    File buffers ({fileRows.length}
                    {fileFilter ? ` of ${Object.keys(ws.files).length}` : ""})
                  </strong>
                  <span style={{ fontSize: 12, color: "var(--fg-muted)" }}>
                    Total ~{formatBytes(totalBytes)}
                  </span>
                </header>
                <input
                  type="text"
                  value={fileFilter}
                  onChange={(e) => setFileFilter(e.target.value)}
                  placeholder="Filter by path…"
                  className="settings-num"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    marginBottom: 8,
                    padding: "4px 8px",
                  }}
                />
                {fileRows.length === 0 ? (
                  <div
                    style={{
                      color: "var(--fg-muted)",
                      fontSize: 12,
                      padding: "6px 0",
                    }}
                  >
                    No file buffers loaded.
                  </div>
                ) : (
                  <div
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      overflow: "hidden",
                    }}
                  >
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        fontSize: 12,
                      }}
                    >
                      <thead>
                        <tr style={{ background: "var(--bg-alt)" }}>
                          <th style={thStyle}>Path</th>
                          <th style={{ ...thStyle, textAlign: "right" }}>
                            Size
                          </th>
                          <th style={{ ...thStyle, textAlign: "center" }}>
                            State
                          </th>
                          <th style={{ ...thStyle, width: 90 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {fileRows.map((r) => {
                          const canUnload =
                            hasUnloadFn && !r.dirty && !r.active;
                          const reason = r.dirty
                            ? "Save the buffer first"
                            : r.active
                              ? "File is the active tab in a pane"
                              : !hasUnloadFn
                                ? "Sweeper not available in this build"
                                : "Drop the buffer from memory";
                          return (
                            <tr
                              key={r.path}
                              style={{ borderTop: "1px solid var(--border)" }}
                            >
                              <td
                                style={{
                                  ...tdStyle,
                                  fontFamily:
                                    "Cascadia Mono, Consolas, monospace",
                                  whiteSpace: "nowrap",
                                  overflow: "hidden",
                                  textOverflow: "ellipsis",
                                  maxWidth: 360,
                                }}
                                title={r.path}
                              >
                                {r.rel}
                              </td>
                              <td
                                style={{ ...tdStyle, textAlign: "right" }}
                                title={`${r.bytes} bytes`}
                              >
                                {formatBytes(r.bytes)}
                              </td>
                              <td
                                style={{ ...tdStyle, textAlign: "center" }}
                              >
                                {r.dirty ? (
                                  <span style={{ color: "var(--warn, #d4a017)" }}>
                                    ● dirty
                                  </span>
                                ) : r.active ? (
                                  <span style={{ color: "var(--fg-muted)" }}>
                                    active
                                  </span>
                                ) : (
                                  <span style={{ color: "var(--fg-muted)" }}>
                                    idle
                                  </span>
                                )}
                              </td>
                              <td style={{ ...tdStyle, textAlign: "right" }}>
                                <button
                                  type="button"
                                  disabled={!canUnload}
                                  onClick={() => handleUnload(r.path)}
                                  title={reason}
                                  style={btnStyle}
                                >
                                  Unload
                                </button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>

              <section>
                <header
                  style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    marginBottom: 8,
                  }}
                >
                  <strong style={{ fontSize: 13 }}>
                    Terminals ({termRows.length}
                    {termFilter
                      ? ` of ${Object.keys(ws.terminals).length}`
                      : ""}
                    )
                  </strong>
                </header>
                <input
                  type="text"
                  value={termFilter}
                  onChange={(e) => setTermFilter(e.target.value)}
                  placeholder="Filter by title…"
                  className="settings-num"
                  style={{
                    width: "100%",
                    boxSizing: "border-box",
                    marginBottom: 8,
                    padding: "4px 8px",
                  }}
                />
                {termRows.length === 0 ? (
                  <div
                    style={{
                      color: "var(--fg-muted)",
                      fontSize: 12,
                      padding: "6px 0",
                    }}
                  >
                    No terminals running.
                  </div>
                ) : (
                  <div
                    style={{
                      border: "1px solid var(--border)",
                      borderRadius: 6,
                      overflow: "hidden",
                    }}
                  >
                    <table
                      style={{
                        width: "100%",
                        borderCollapse: "collapse",
                        fontSize: 12,
                      }}
                    >
                      <thead>
                        <tr style={{ background: "var(--bg-alt)" }}>
                          <th style={thStyle}>Title</th>
                          <th style={{ ...thStyle, textAlign: "center" }}>
                            State
                          </th>
                          <th style={{ ...thStyle, width: 90 }}></th>
                        </tr>
                      </thead>
                      <tbody>
                        {termRows.map((r) => (
                          <tr
                            key={r.id}
                            style={{ borderTop: "1px solid var(--border)" }}
                          >
                            <td style={tdStyle}>{r.title}</td>
                            <td
                              style={{ ...tdStyle, textAlign: "center" }}
                            >
                              {r.popped ? (
                                <span style={{ color: "var(--accent, #7c9eff)" }}>
                                  popped out
                                </span>
                              ) : (
                                <span style={{ color: "var(--fg-muted)" }}>
                                  in-tab
                                </span>
                              )}
                            </td>
                            <td style={{ ...tdStyle, textAlign: "right" }}>
                              <button
                                type="button"
                                onClick={() => handleCloseTerminal(r.id)}
                                title="Kill PTY and close the tab"
                                style={btnStyle}
                              >
                                Close
                              </button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </section>
            </>
          )}
        </div>
        <div className="settings-foot">
          <span>
            Live snapshot · totals reflect in-memory buffers, not disk size
          </span>
          <button onClick={onClose}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const thStyle: React.CSSProperties = {
  textAlign: "left",
  padding: "6px 10px",
  fontWeight: 500,
  fontSize: 11,
  color: "var(--fg-muted)",
  textTransform: "uppercase",
  letterSpacing: 0.4,
};

const tdStyle: React.CSSProperties = {
  padding: "6px 10px",
  verticalAlign: "middle",
};

const btnStyle: React.CSSProperties = {
  fontSize: 11,
  padding: "3px 10px",
  cursor: "pointer",
};
