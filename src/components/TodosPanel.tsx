import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { setEditorGoto } from "../editorState";
import { errMsg } from "../notify";
import { relPath } from "../pathUtils";
import { Icon } from "./Icon";

interface TodoHit {
  path: string;
  line: number;
  kind: string;
  text: string;
}

interface Props {
  wsId: string;
  root: string;
}

interface CacheEntry {
  hits: TodoHit[];
  scannedAt: number;
}

// Module-level cache keyed by root. Persists across mounts so switching
// to the TODOs tab is instant after the first scan; the user can still
// hit ⟳ for a fresh scan.
const todoCache = new Map<string, CacheEntry>();

// Keep render cost bounded. On large repos with many hits, rendering
// every row on first paint causes long jank. Show the first slice and
// let the user click to expand.
const RENDER_INITIAL_GROUPS = 40;

export function TodosPanel({ wsId, root }: Props) {
  const cached = root ? todoCache.get(root) : undefined;
  const [hits, setHits] = useState<TodoHit[]>(cached?.hits ?? []);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [filter, setFilter] = useState("");
  // Tags toggled OFF by user. ON by default; absence = visible.
  const [hiddenKinds, setHiddenKinds] = useState<Set<string>>(new Set());
  const [scannedAt, setScannedAt] = useState<number | null>(
    cached?.scannedAt ?? null,
  );
  // Guard against stale results from a slower scan landing after a newer
  // one (e.g. user mashes the refresh button or switches roots quickly).
  const scanIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    if (!root) return;
    const id = ++scanIdRef.current;
    setError(null);
    setScanning(true);
    try {
      const out = await invoke<TodoHit[]>("scan_todos", {
        root,
        maxResults: 1000,
      });
      if (!mountedRef.current || scanIdRef.current !== id) return;
      todoCache.set(root, { hits: out, scannedAt: Date.now() });
      setHits(out);
      setScannedAt(Date.now());
    } catch (e) {
      if (!mountedRef.current || scanIdRef.current !== id) return;
      setError(errMsg(e));
      setHits([]);
    } finally {
      if (mountedRef.current && scanIdRef.current === id) {
        setScanning(false);
      }
    }
  }, [root]);

  // Auto-scan on first mount per workspace; subsequent mounts use cache.
  // On root change, also reset the per-root view state (expanded toggle,
  // filter text) so a stale UI from the previous workspace doesn't leak.
  useEffect(() => {
    setExpanded(false);
    setFilter("");
    setHiddenKinds(new Set());
    setError(null);
    if (!root) {
      setHits([]);
      setScannedAt(null);
      return;
    }
    if (todoCache.has(root)) {
      const c = todoCache.get(root)!;
      setHits(c.hits);
      setScannedAt(c.scannedAt);
      return;
    }
    // Clear stale hits while the new scan runs so we don't briefly show
    // results from the previous root.
    setHits([]);
    setScannedAt(null);
    void refresh();
  }, [root, refresh]);

  // Text filter: case-insensitive substring match against the comment text.
  const textFilteredHits = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return hits;
    return hits.filter((h) => h.text.toLowerCase().includes(q));
  }, [hits, filter]);

  // Distinct tags present in the current text-filtered results — drives
  // the chip row. Stable order: first-seen.
  const kindsInResults = useMemo(() => {
    const seen: string[] = [];
    const set = new Set<string>();
    for (const h of textFilteredHits) {
      if (!set.has(h.kind)) {
        set.add(h.kind);
        seen.push(h.kind);
      }
    }
    return seen;
  }, [textFilteredHits]);

  // Apply tag toggles on top of the text filter.
  const filteredHits = useMemo(() => {
    if (hiddenKinds.size === 0) return textFilteredHits;
    return textFilteredHits.filter((h) => !hiddenKinds.has(h.kind));
  }, [textFilteredHits, hiddenKinds]);

  const isFiltering = filter.trim().length > 0 || hiddenKinds.size > 0;

  const toggleKind = (kind: string) => {
    setHiddenKinds((prev) => {
      const next = new Set(prev);
      if (next.has(kind)) next.delete(kind);
      else next.add(kind);
      return next;
    });
  };

  const groups = useMemo(() => {
    const m = new Map<string, TodoHit[]>();
    for (const h of filteredHits) {
      const existing = m.get(h.path);
      if (existing) existing.push(h);
      else m.set(h.path, [h]);
    }
    return Array.from(m.entries());
  }, [filteredHits]);

  const visibleGroups = expanded
    ? groups
    : groups.slice(0, RENDER_INITIAL_GROUPS);
  const hiddenGroupCount = groups.length - visibleGroups.length;

  const onHitClick = async (hit: TodoHit) => {
    await useStore.getState().openFile(wsId, hit.path);
    setEditorGoto(hit.line, 1);
  };

  return (
    <div className="todos-panel">
      <div className="todos-header">
        <span>
          Tasks &amp; TODOs
          {hits.length > 0 && (
            <span className="todos-count">
              {" "}·{" "}
              {isFiltering
                ? `${filteredHits.length} of ${hits.length}`
                : hits.length}
            </span>
          )}
        </span>
        <button
          onClick={() => void refresh()}
          disabled={scanning}
          title={
            scannedAt
              ? `Last scanned ${new Date(scannedAt).toLocaleTimeString()}`
              : "Scan workspace"
          }
          aria-label="Rescan workspace for TODOs"
        >
          {scanning ? "…" : <Icon name="refresh" size={14} />}
        </button>
      </div>
      {hits.length > 0 && (
        <div className="todos-filter">
          <input
            type="text"
            placeholder="Filter comments…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            aria-label="Filter TODOs"
          />
          {filter && (
            <button
              className="todos-filter-clear"
              onClick={() => setFilter("")}
              title="Clear filter"
              aria-label="Clear filter"
            >
              <Icon name="x" size={12} />
            </button>
          )}
        </div>
      )}
      {hits.length > 0 && kindsInResults.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 4,
            padding: "4px 8px 6px",
          }}
        >
          {kindsInResults.map((kind) => {
            const active = !hiddenKinds.has(kind);
            return (
              <button
                key={kind}
                type="button"
                onClick={() => toggleKind(kind)}
                aria-pressed={active}
                title={
                  active ? `Hide ${kind} entries` : `Show ${kind} entries`
                }
                style={{
                  fontSize: 10,
                  lineHeight: 1,
                  padding: "3px 7px",
                  borderRadius: 999,
                  border: `1px solid ${
                    active
                      ? "var(--accent, #4ea1ff)"
                      : "var(--border, #444)"
                  }`,
                  background: active
                    ? "color-mix(in srgb, var(--accent, #4ea1ff) 18%, transparent)"
                    : "transparent",
                  color: active
                    ? "var(--fg, #ddd)"
                    : "var(--fg-muted, #888)",
                  cursor: "pointer",
                  textTransform: "uppercase",
                  letterSpacing: 0.4,
                  fontWeight: 600,
                }}
              >
                {kind}
              </button>
            );
          })}
        </div>
      )}
      {scanning && hits.length === 0 && (
        <div className="todos-group todos-empty">Scanning workspace…</div>
      )}
      {!scanning && !error && hits.length === 0 && (
        <div className="todos-group todos-empty">
          No TODOs found in scannable files.
        </div>
      )}
      {!scanning && !error && hits.length > 0 && filteredHits.length === 0 && (
        <div className="todos-group todos-empty">No matches for filter.</div>
      )}
      {error && <div className="todos-group todos-error">{error}</div>}
      {visibleGroups.map(([path, items]) => (
        <div key={path} className="todos-group">
          <div className="todos-group-header">
            <span>{relPath(path, root)}</span>
            <span>{items.length}</span>
          </div>
          {items.map((hit, i) => (
            <div
              key={`${hit.path}:${hit.line}:${i}`}
              className="todo-hit"
              onClick={() => void onHitClick(hit)}
            >
              <span className="todo-kind" data-kind={hit.kind}>
                {hit.kind}
              </span>
              <span className="todo-line">{hit.line}</span>
              <span className="todo-text">{hit.text}</span>
            </div>
          ))}
        </div>
      ))}
      {hiddenGroupCount > 0 && (
        <button
          className="todos-show-more"
          onClick={() => setExpanded(true)}
        >
          Show {hiddenGroupCount} more file{hiddenGroupCount === 1 ? "" : "s"}…
        </button>
      )}
    </div>
  );
}
