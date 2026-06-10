import { useCallback, useEffect, useState } from "react";
import { findTabsPaneByTab, termKey, useStore } from "../store";
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

// Session-local task → terminal binding so repeated Run clicks reuse one
// shell instead of piling up a new terminal per click. Module-level (not
// store state) on purpose: the store's TerminalShell can't carry a title
// without also overriding which shell binary spawns, and there's no
// rename-terminal action — so reuse-by-title isn't expressible without
// store changes. A plain Map survives panel unmount/remount (sidebar
// section collapse) but intentionally resets with the page, matching the
// "this session" semantics. Keyed by wsId + kind + name so a Rust + JS
// project's two "build" tasks get separate terminals.
const sessionTaskTerms = new Map<string, string>();
const taskMapKey = (wsId: string, task: Task) =>
  `${wsId}|${task.kind}:${task.name}`;

/** Bring an existing terminal tab to the front, revealing the bottom
 *  panel if that's where it lives. No-op if the tab is gone. */
function focusTerminalTab(wsId: string, termId: string): void {
  const state = useStore.getState();
  const ws = state.loaded[wsId];
  if (!ws) return;
  const k = termKey(termId);
  const inBottom = ws.layout.bottomRoot
    ? findTabsPaneByTab(ws.layout.bottomRoot, k)
    : null;
  const pane = inBottom ?? findTabsPaneByTab(ws.layout.editorRoot, k);
  if (!pane) return;
  if (inBottom && !ws.layout.bottomVisible) {
    state.setBottomVisible(wsId, true);
  }
  state.setActiveTab(wsId, pane.id, k);
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

  const runTask = async (task: Task) => {
    const key = taskMapKey(wsId, task);
    // Reuse the terminal a previous Run created for this task, but only
    // when its PTY is still alive — a dead shell would swallow the write.
    // We deliberately do NOT send Ctrl+C first: we can't tell whether the
    // previous run is still going, and interrupting a dev server the user
    // is relying on would be worse than the command queueing at a prompt.
    const prevTermId = sessionTaskTerms.get(key);
    if (prevTermId) {
      const desc = useStore.getState().loaded[wsId]?.terminals[prevTermId];
      let alive = false;
      if (desc?.ptyId) {
        try {
          alive = await pty.sessionExists(desc.ptyId);
        } catch {
          alive = false;
        }
      }
      if (desc?.ptyId && alive) {
        focusTerminalTab(wsId, prevTermId);
        void pty.write(desc.ptyId, `${task.runCmd}\r`).catch(() => {});
        return;
      }
      // Terminal was closed or its shell exited — fall through and spawn
      // a fresh one under the same task key.
      sessionTaskTerms.delete(key);
    }
    const termId = useStore.getState().addTerminal(wsId, "bottom");
    sessionTaskTerms.set(key, termId);
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

  // Reactive read of the workspace's terminals so rows flip between
  // Run / Run+Stop as task terminals appear and get closed. The map
  // itself is module-level; this selector is what re-renders us when a
  // mapped terminal is closed (its descriptor leaves the store).
  const terminals = useStore((s) => s.loaded[wsId]?.terminals);

  /** The live terminal bound to this task this session, if any. */
  const taskTerminal = (task: Task) => {
    const termId = sessionTaskTerms.get(taskMapKey(wsId, task));
    return termId ? terminals?.[termId] : undefined;
  };

  // Ctrl+C the task's terminal. We send the interrupt rather than kill
  // the PTY so the shell (and its scrollback) survives for a re-run.
  const stopTask = (task: Task) => {
    const desc = taskTerminal(task);
    if (desc?.ptyId) {
      void pty.write(desc.ptyId, "\x03").catch(() => {});
      focusTerminalTab(wsId, desc.id);
    }
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
          {group.items.map((s) => {
            const live = taskTerminal(s);
            return (
              <div key={`${group.kind}:${s.name}`} className="task-row">
                <div>
                  <div className="task-name">
                    {live && (
                      <span
                        className="task-live-dot"
                        title="Started this session — terminal is open"
                        aria-hidden
                      />
                    )}
                    {s.name}
                  </div>
                  <div className="task-cmd">{s.command}</div>
                </div>
                <div className="task-actions">
                  {live && (
                    <button
                      className="task-run task-stop"
                      onClick={() => stopTask(s)}
                      title="Send Ctrl+C to this task's terminal"
                      aria-label={`Stop ${s.name}`}
                    >
                      <Icon name="stop" size={12} />
                      <span>Stop</span>
                    </button>
                  )}
                  <button
                    className="task-run"
                    onClick={() => void runTask(s)}
                    title={
                      live
                        ? `Run "${s.runCmd}" in its existing terminal`
                        : `Run "${s.runCmd}" in a bottom-panel terminal`
                    }
                    aria-label={`Run ${s.name}`}
                  >
                    <Icon name="play" size={12} />
                    <span>Run</span>
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
