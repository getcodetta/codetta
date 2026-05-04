import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { setEditorGoto } from "../editorState";

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

function relativePath(path: string, root: string): string {
  if (!root) return path;
  const normRoot = root.replace(/[\\/]+$/, "");
  if (path.startsWith(normRoot)) {
    const rest = path.slice(normRoot.length);
    return rest.replace(/^[\\/]+/, "");
  }
  return path;
}

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
      setError(e instanceof Error ? e.message : String(e));
      setHits([]);
    } finally {
      if (mountedRef.current && scanIdRef.current === id) {
        setScanning(false);
      }
    }
  }, [root]);

  // Auto-scan on first mount per workspace; subsequent mounts use cache.
  useEffect(() => {
    if (!root) return;
    if (todoCache.has(root)) {
      const c = todoCache.get(root)!;
      setHits(c.hits);
      setScannedAt(c.scannedAt);
      return;
    }
    void refresh();
  }, [root, refresh]);

  const groups = useMemo(() => {
    const m = new Map<string, TodoHit[]>();
    for (const h of hits) {
      const existing = m.get(h.path);
      if (existing) existing.push(h);
      else m.set(h.path, [h]);
    }
    return Array.from(m.entries());
  }, [hits]);

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
            <span className="todos-count"> · {hits.length}</span>
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
        >
          {scanning ? "…" : "⟳"}
        </button>
      </div>
      {scanning && hits.length === 0 && (
        <div className="todos-group todos-empty">Scanning workspace…</div>
      )}
      {!scanning && !error && hits.length === 0 && (
        <div className="todos-group todos-empty">
          No TODOs found in scannable files.
        </div>
      )}
      {error && <div className="todos-group todos-error">{error}</div>}
      {visibleGroups.map(([path, items]) => (
        <div key={path} className="todos-group">
          <div className="todos-group-header">
            <span>{relativePath(path, root)}</span>
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
