import { useCallback, useEffect, useMemo, useState } from "react";
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

function relativePath(path: string, root: string): string {
  if (!root) return path;
  const normRoot = root.replace(/[\\/]+$/, "");
  if (path.startsWith(normRoot)) {
    const rest = path.slice(normRoot.length);
    return rest.replace(/^[\\/]+/, "");
  }
  return path;
}

export function TodosPanel({ wsId, root }: Props) {
  const [hits, setHits] = useState<TodoHit[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const out = await invoke<TodoHit[]>("scan_todos", {
        root,
        maxResults: 1000,
      });
      setHits(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setHits([]);
    }
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const groups = useMemo(() => {
    const m = new Map<string, TodoHit[]>();
    for (const h of hits) {
      const existing = m.get(h.path);
      if (existing) existing.push(h);
      else m.set(h.path, [h]);
    }
    return Array.from(m.entries());
  }, [hits]);

  const onHitClick = async (hit: TodoHit) => {
    await useStore.getState().openFile(wsId, hit.path);
    setEditorGoto(hit.line, 1);
  };

  return (
    <div className="todos-panel">
      <div className="todos-header">
        <span>Tasks & TODOs</span>
        <button onClick={() => void refresh()}>⟳</button>
      </div>
      {error && <div className="todos-group">{error}</div>}
      {groups.map(([path, items]) => (
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
    </div>
  );
}
