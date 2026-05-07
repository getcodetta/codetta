import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useStore } from "../store";
import { fs, pty } from "../ipc";
import { errMsg } from "../notify";
import { Icon } from "./Icon";

interface PackageScript {
  name: string;
  command: string;
}

interface Props {
  wsId: string;
  root: string;
}

type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

// Detect the project's package manager by which lockfile is present.
// Falls back to npm when nothing definitive is found. Order matters:
// pnpm/yarn/bun lockfiles co-existing with package-lock.json is rare
// but real (CI artifacts), so check the more specific ones first.
// Uses fs.exists rather than reading the file — package-lock.json on
// large monorepos can be tens of megabytes; we only care whether the
// path resolves.
async function detectPackageManager(root: string): Promise<PackageManager> {
  const candidates: Array<{ file: string; pm: PackageManager }> = [
    { file: "pnpm-lock.yaml", pm: "pnpm" },
    { file: "bun.lockb", pm: "bun" },
    { file: "bun.lock", pm: "bun" },
    { file: "yarn.lock", pm: "yarn" },
    { file: "package-lock.json", pm: "npm" },
  ];
  const base = root.replace(/[\\/]+$/, "");
  for (const { file, pm } of candidates) {
    try {
      if (await fs.exists(`${base}/${file}`)) return pm;
    } catch {
      /* fs.exists shouldn't throw, but defend against it */
    }
  }
  return "npm";
}

export function TasksPanel({ wsId, root }: Props) {
  const [scripts, setScripts] = useState<PackageScript[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pm, setPm] = useState<PackageManager>("npm");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [out, detected] = await Promise.all([
        invoke<PackageScript[]>("read_package_scripts", { root }),
        detectPackageManager(root),
      ]);
      setScripts(out);
      setPm(detected);
    } catch (e) {
      setError(errMsg(e));
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
    // pnpm/yarn/bun let you skip "run" for non-reserved script names,
    // but the explicit form works with all four and avoids the
    // "missing script" footgun for scripts that share names with
    // built-in commands ("test", "start").
    const cmd = pm === "yarn" ? `yarn run ${name}` : `${pm} run ${name}`;

    // Wait for the new terminal's PTY id to appear in the store. The
    // subscription fires on every state change, so we capture a stable
    // unsub handle and gate by termId. A 15s timeout sweeps the
    // subscription if the PTY never spawns (Rust error, user closed
    // the term tab) — without this, a subscription leaks for the
    // lifetime of the page on every failed run.
    let cleanup: (() => void) | null = null;
    const timeout = window.setTimeout(() => {
      cleanup?.();
    }, 15000);
    const unsub = useStore.subscribe((state) => {
      const desc = state.loaded[wsId]?.terminals[termId];
      if (desc?.ptyId) {
        void pty.write(desc.ptyId, `${cmd}\r`);
        cleanup?.();
      }
    });
    cleanup = () => {
      window.clearTimeout(timeout);
      unsub();
      cleanup = null;
    };
  };

  return (
    <div className="tasks-panel">
      <div className="tasks-header">
        <span>
          Tasks
          {scripts.length > 0 && (
            <span
              className="tasks-pm"
              title={`Detected ${pm} from lockfile — scripts will run via "${pm} run <script>"`}
            >
              {" "}
              · {pm}
            </span>
          )}
        </span>
        <button
          onClick={() => void refresh()}
          title="Re-scan package.json"
          aria-label="Re-scan package.json"
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {error && <div className="tasks-empty">{error}</div>}
      {!error && loading && scripts.length === 0 && (
        <div className="tasks-empty">Scanning package.json…</div>
      )}
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
                title={`Run "${pm} run ${s.name}" in a new bottom-panel terminal`}
                aria-label={`Run ${s.name} script`}
              >
                <Icon name="play" size={12} />
                <span>Run</span>
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
