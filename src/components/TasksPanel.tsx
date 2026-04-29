import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { pty } from "../ipc";

interface PackageScript {
  name: string;
  command: string;
}

interface Props {
  wsId: string;
  root: string;
}

export function TasksPanel({ wsId, root }: Props) {
  const [scripts, setScripts] = useState<PackageScript[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const out = await invoke<PackageScript[]>("read_package_scripts", {
        root,
      });
      setScripts(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setScripts([]);
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runScript = (name: string) => {
    const termId = useStore.getState().addTerminal(wsId, "bottom");
    const unsub = useStore.subscribe((state) => {
      const desc = state.loaded[wsId]?.terminals[termId];
      if (desc?.ptyId) {
        void pty.write(desc.ptyId, `npm run ${name}\r`);
        unsub();
      }
    });
  };

  return (
    <div className="tasks-panel">
      <div className="tasks-header">
        <span>Tasks</span>
        <button onClick={() => void refresh()}>⟳</button>
      </div>
      {error && <div className="tasks-empty">{error}</div>}
      {!error && !loading && scripts.length === 0 && (
        <div className="tasks-empty">No package.json scripts found</div>
      )}
      {scripts.length > 0 && (
        <div className="tasks-list">
          {scripts.map((s) => (
            <div key={s.name} className="task-row">
              <div>
                <div className="task-name">{s.name}</div>
                <div className="task-cmd">{s.command}</div>
              </div>
              <button
                className="task-run"
                onClick={() => runScript(s.name)}
              >
                ▷ Run
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
