// Composer card — shown when an agentic turn made 2+ file-modifying tool
// calls. Aggregates them into a single header (file count + line stats)
// with collapsible per-file diffs and quick "open file" / "revert all"
// shortcuts. Replaces the per-call inline rows for those calls so the
// chat doesn't sprawl into 5 separate diff cards.
//
// Lives outside AIChatPanel so the chat panel doesn't have to host
// another 200 lines of UI logic. Pure component — props in, render out;
// the only side-effects are file writes triggered by the Revert button.

import { useMemo, useState } from "react";
import type { ToolCall } from "../ai";
import {
  diffStats,
  extractEditDiffs,
  pathOf,
  UnifiedDiff,
} from "./chatToolRender";
import { dropSnapshot, lookupSnapshot } from "../composeSnapshots";
import { confirm as dialogConfirm } from "../dialog";
import { fs } from "../ipc";
import {
  error as toastError,
  errMsg,
  success as toastSuccess,
} from "../notify";
import { useStore } from "../store";

/**
 * Revert button rendered inside the ComposeCard header. Looks up the
 * pre-turn snapshot captured by sendUserText, then writes each touched
 * path's old content back to disk. Only enabled when (a) a snapshot
 * exists for this turn and (b) at least one of the touched paths is in
 * the snapshot.
 */
function ComposeRevertButton({
  wsId,
  chatId,
  msgIndex,
  touchedPaths,
}: {
  wsId: string;
  chatId: string | undefined;
  msgIndex: number;
  touchedPaths: string[];
}) {
  const [reverted, setReverted] = useState(false);
  const snap = lookupSnapshot(wsId, chatId, msgIndex);
  // Only paths that were both modified by the agent AND captured in
  // the pre-turn snapshot can be reverted. A file the agent created
  // (Write to a brand-new path) won't be in the snapshot — we leave
  // those alone since "revert" would mean delete, which is too
  // destructive for a one-click action.
  const restorable = snap
    ? touchedPaths.filter((p) => snap.files.has(p))
    : [];
  const eligible = restorable.length;
  const canRevert = !reverted && eligible > 0;

  const onClick = async () => {
    if (!snap || eligible === 0) return;
    const ok = await dialogConfirm(
      `Revert ${eligible} file${eligible === 1 ? "" : "s"} back to the pre-turn state? Local edits made AFTER the agent's turn will also be discarded.`,
      {
        title: "Revert all changes",
        okLabel: "Revert",
        cancelLabel: "Cancel",
        danger: true,
      },
    );
    if (!ok) return;
    let okCount = 0;
    const failures: string[] = [];
    for (const path of restorable) {
      try {
        const before = snap.files.get(path);
        if (before === undefined) continue;
        // Write to disk via the IPC layer + update the in-memory
        // buffer so Monaco picks it up immediately.
        await fs.writeFile(path, before);
        useStore.setState((s) => {
          const w = s.loaded[wsId];
          if (!w?.files[path]) return s;
          return {
            loaded: {
              ...s.loaded,
              [wsId]: {
                ...w,
                files: {
                  ...w.files,
                  [path]: { contents: before, original: before },
                },
              },
            },
          };
        });
        okCount++;
      } catch (e) {
        failures.push(
          `${path.split(/[\\/]/).pop()}: ${errMsg(e)}`,
        );
      }
    }
    setReverted(true);
    dropSnapshot(wsId, chatId, msgIndex);
    if (failures.length === 0) {
      toastSuccess(`Reverted ${okCount} file${okCount === 1 ? "" : "s"}`);
    } else {
      toastError(
        `Reverted ${okCount}/${restorable.length}; ${failures.length} failed (see console)`,
      );
      console.warn("Compose revert failures:", failures);
    }
  };

  if (reverted) {
    return (
      <span className="ai-compose-reverted" title="Files restored to pre-turn state">
        ✓ Reverted
      </span>
    );
  }
  if (!canRevert) {
    return (
      <button
        className="ai-compose-revert"
        disabled
        title={
          snap
            ? "No restorable files in the pre-turn snapshot (the agent may have created new files)"
            : "No pre-turn snapshot available — Revert only works for turns started after page load with this feature live"
        }
      >
        Revert
      </button>
    );
  }
  return (
    <button
      className="ai-compose-revert"
      onClick={() => void onClick()}
      title={`Roll ${eligible} file${eligible === 1 ? "" : "s"} back to pre-turn state`}
    >
      ↶ Revert {eligible}
    </button>
  );
}

export function ComposeCard({
  wsId,
  chatId,
  msgIndex,
  calls,
}: {
  wsId: string;
  chatId: string | undefined;
  msgIndex: number;
  calls: ToolCall[];
}) {
  const [collapsed, setCollapsed] = useState(false);
  // Group calls by target file, since one turn can hit the same
  // file multiple times (Edit + Edit).
  const byPath = useMemo(() => {
    const m = new Map<string, ToolCall[]>();
    for (const c of calls) {
      const p = pathOf(c);
      const arr = m.get(p);
      if (arr) arr.push(c);
      else m.set(p, [c]);
    }
    return Array.from(m.entries()); // [path, calls[]]
  }, [calls]);

  // Aggregate stats across every call in the turn.
  const totals = useMemo(() => {
    let added = 0;
    let removed = 0;
    for (const c of calls) {
      const d = extractEditDiffs(c);
      if (d) {
        const s = diffStats(d);
        added += s.added;
        removed += s.removed;
      }
    }
    return { added, removed };
  }, [calls]);

  const openFile = async (path: string) => {
    try {
      await useStore.getState().openFile(wsId, path);
    } catch {
      /* file may not exist (Write to a new path that didn't take) */
    }
  };

  const openAll = async () => {
    for (const [path] of byPath) await openFile(path);
  };

  return (
    <div className="ai-compose-card">
      <div className="ai-compose-head">
        <button
          className="ai-compose-toggle"
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? "Expand all diffs" : "Collapse"}
        >
          {collapsed ? "▸" : "▾"}
        </button>
        <div className="ai-compose-title">
          <strong>Compose</strong>
          <span className="ai-compose-meta">
            {byPath.length} file{byPath.length === 1 ? "" : "s"} ·
            <span className="ai-compose-add"> +{totals.added}</span>
            <span className="ai-compose-rem"> −{totals.removed}</span>
          </span>
        </div>
        <button
          className="ai-compose-open-all"
          onClick={() => void openAll()}
          title="Open every modified file in editor tabs"
        >
          Open all
        </button>
        <ComposeRevertButton
          wsId={wsId}
          chatId={chatId}
          msgIndex={msgIndex}
          touchedPaths={byPath.map(([p]) => p)}
        />
      </div>
      {!collapsed && (
        <div className="ai-compose-files">
          {byPath.map(([path, fileCalls]) => {
            const stats = fileCalls.reduce(
              (acc, c) => {
                const d = extractEditDiffs(c);
                if (!d) return acc;
                const s = diffStats(d);
                return {
                  added: acc.added + s.added,
                  removed: acc.removed + s.removed,
                };
              },
              { added: 0, removed: 0 },
            );
            const shortPath = (() => {
              const parts = path.replace(/\\/g, "/").split("/").filter(Boolean);
              if (parts.length <= 2) return path.replace(/\\/g, "/");
              return "…/" + parts.slice(-2).join("/");
            })();
            return (
              <div key={path} className="ai-compose-file">
                <div className="ai-compose-file-head">
                  <button
                    className="ai-compose-path"
                    onClick={() => void openFile(path)}
                    title={path}
                  >
                    {shortPath}
                  </button>
                  <span className="ai-compose-file-stats">
                    <span className="ai-compose-add">+{stats.added}</span>
                    <span className="ai-compose-rem">−{stats.removed}</span>
                    <span className="ai-compose-file-kind">
                      {fileCalls.length > 1
                        ? `${fileCalls.length} edits`
                        : fileCalls[0].function.name}
                    </span>
                  </span>
                </div>
                {fileCalls.map((c, i) => {
                  const diffs = extractEditDiffs(c);
                  if (!diffs) return null;
                  return (
                    <div key={c.id ?? i} className="ai-compose-file-body">
                      {diffs.map((d, k) => (
                        <UnifiedDiff
                          key={k}
                          oldText={d.oldText}
                          newText={d.newText}
                        />
                      ))}
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
