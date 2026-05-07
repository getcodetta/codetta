import { useCallback, useEffect, useState } from "react";
import { useStore } from "../store";
import { fs, pty, search } from "../ipc";
import { errMsg } from "../notify";
import { Icon } from "./Icon";

interface PackageScript {
  name: string;
  command: string;
}

// One row in the panel. `kind` lets us group + label so a Rust + JS
// project doesn't show "build" twice with no visual hint about which
// build (cargo build vs. npm run build).
type TaskKind = "package" | "cargo" | "make";
interface Task extends PackageScript {
  kind: TaskKind;
  /** Verbatim command to send to the terminal. For package scripts
   *  this differs from `command` (which is the script body) — we
   *  build "<pm> run <name>" at run time. For cargo/make it's the
   *  full invocation already. */
  runCmd: string;
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
  const [tasks, setTasks] = useState<Task[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [pm, setPm] = useState<PackageManager>("npm");

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // Fan out to every task source in parallel — they're independent
      // and the cheapest path to a snappy refresh on big monorepos.
      const [pkgs, cargoTasks, makeTargets, detected] = await Promise.all([
        search.readPackageScripts(root).catch(() => [] as PackageScript[]),
        search.readCargoTasks(root).catch(() => [] as PackageScript[]),
        search.readMakefileTargets(root).catch(() => [] as PackageScript[]),
        detectPackageManager(root),
      ]);
      setPm(detected);
      const merged: Task[] = [];
      // Order: package.json first (most common), then cargo, then make.
      // Within each group we keep the source's own ordering (alphabetic
      // for package + cargo, file order for make — useful because
      // Makefile authors put the headline target first).
      const pmRun = (name: string) =>
        detected === "yarn" ? `yarn run ${name}` : `${detected} run ${name}`;
      for (const s of pkgs) {
        merged.push({ ...s, kind: "package", runCmd: pmRun(s.name) });
      }
      for (const s of cargoTasks) {
        // Strip the trailing "  # description" comment — useful in the
        // panel hint, but we don't want to ship it down the terminal.
        const runCmd = s.command.split("  # ")[0];
        merged.push({ ...s, kind: "cargo", runCmd });
      }
      for (const s of makeTargets) {
        merged.push({ ...s, kind: "make", runCmd: s.command });
      }
      setTasks(merged);
    } catch (e) {
      setError(errMsg(e));
      setTasks([]);
    } finally {
      setLoading(false);
    }
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const runTask = (task: Task) => {
    const termId = useStore.getState().addTerminal(wsId, "bottom");
    const cmd = task.runCmd;
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

  // Group tasks by kind for rendering. Empty groups disappear.
  const grouped: Array<{ kind: TaskKind; label: string; items: Task[] }> = (
    [
      { kind: "package", label: pm, items: tasks.filter((t) => t.kind === "package") },
      { kind: "cargo", label: "cargo", items: tasks.filter((t) => t.kind === "cargo") },
      { kind: "make", label: "make", items: tasks.filter((t) => t.kind === "make") },
    ] as Array<{ kind: TaskKind; label: string; items: Task[] }>
  ).filter((g) => g.items.length > 0);

  return (
    <div className="tasks-panel">
      <div className="tasks-header">
        <span>Tasks</span>
        <button
          onClick={() => void refresh()}
          title="Re-scan package.json, Cargo.toml, and Makefile"
          aria-label="Re-scan tasks"
        >
          <Icon name="refresh" size={14} />
        </button>
      </div>
      {error && <div className="tasks-empty">{error}</div>}
      {!error && loading && tasks.length === 0 && (
        <div className="tasks-empty">Scanning project…</div>
      )}
      {!error && !loading && tasks.length === 0 && (
        <div className="tasks-empty">
          No package.json scripts, Cargo manifest, or Makefile found
        </div>
      )}
      {grouped.map((group) => (
        <div key={group.kind} className="tasks-list">
          <div className="tasks-group-label">{group.label}</div>
          {group.items.map((s) => (
            <div key={`${group.kind}:${s.name}`} className="task-row">
              <div>
                <div className="task-name">{s.name}</div>
                <div className="task-cmd">{s.command}</div>
              </div>
              <button
                className="task-run"
                onClick={() => runTask(s)}
                title={`Run "${s.runCmd}" in a new bottom-panel terminal`}
                aria-label={`Run ${s.name}`}
              >
                <Icon name="play" size={12} />
                <span>Run</span>
              </button>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}
