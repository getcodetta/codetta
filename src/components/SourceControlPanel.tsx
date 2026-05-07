import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { fsBus } from "../fsBus";
import { fs, git as gitApi } from "../ipc";
import { requestDiff } from "../editorState";
import { error as toastError, success as toastSuccess } from "../notify";
import { confirm as dialogConfirm } from "../dialog";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";

const langByExt: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  rs: "rust",
  py: "python",
  html: "html",
  css: "css",
  scss: "scss",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  sh: "shell",
  ps1: "powershell",
  sql: "sql",
  xml: "xml",
};
function langOf(p: string): string {
  const m = p.toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && langByExt[m[1]]) || "plaintext";
}
function joinPath(root: string, rel: string): string {
  const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
  const x = rel.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${r}/${x}`;
}

interface GitFile {
  path: string;
  index_status: string;
  worktree_status: string;
  staged: boolean;
  modified: boolean;
}

interface GitStatus {
  is_repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

interface Props {
  wsId: string;
  root: string;
}

function statusLabel(f: GitFile): string {
  if (f.index_status === "?" && f.worktree_status === "?") return "U";
  const i = f.index_status.trim();
  const w = f.worktree_status.trim();
  if (i && w) return `${i}${w}`;
  return i || w || " ";
}

function statusColor(f: GitFile): string {
  const tag = statusLabel(f);
  if (tag.includes("U")) return "#73c990";
  if (tag.includes("A")) return "#73c990";
  if (tag.includes("M")) return "#e2c08d";
  if (tag.includes("D")) return "#c75252";
  if (tag.includes("R")) return "#9cdcfe";
  return "#d4d4d4";
}

export function SourceControlPanel({ wsId, root }: Props) {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [log, setLog] = useState<string>("");
  const [ctx, setCtx] = useState<{ x: number; y: number; file: GitFile } | null>(
    null,
  );
  const [branches, setBranches] = useState<string[]>([]);
  const [branchOpen, setBranchOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const s = await invoke<GitStatus>("git_status", { path: root });
      setStatus(s);
    } catch (e) {
      setStatus({
        is_repo: false,
        branch: null,
        upstream: null,
        ahead: 0,
        behind: 0,
        files: [],
      });
      setLog(String(e));
    }
  }, [root]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    let timer: number | null = null;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as { wsId: string };
      if (detail.wsId !== wsId) return;
      if (timer) window.clearTimeout(timer);
      timer = window.setTimeout(() => void refresh(), 250);
    };
    fsBus.addEventListener("ws", handler);
    return () => {
      fsBus.removeEventListener("ws", handler);
      if (timer) window.clearTimeout(timer);
    };
  }, [wsId, refresh]);

  const run = useCallback(
    async (label: string, cmd: string, args: Record<string, unknown>) => {
      setBusy(label);
      setLog("");
      try {
        const out = await invoke<string>(cmd, args);
        setLog(out);
        await refresh();
      } catch (e) {
        setLog(String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const stage = (path: string) =>
    run("Staging", "git_stage", { path: root, files: [path] });
  const unstage = (path: string) =>
    run("Unstaging", "git_unstage", { path: root, files: [path] });
  const stageAll = () =>
    run("Staging all", "git_stage", {
      path: root,
      files: status?.files.map((f) => f.path) ?? [],
    });
  const commit = async () => {
    if (!message.trim()) return;
    await run("Committing", "git_commit", { path: root, message });
    setMessage("");
  };
  const pull = () => run("Pulling", "git_pull", { path: root });
  const push = () => run("Pushing", "git_push", { path: root });
  const fetch_ = () => run("Fetching", "git_fetch", { path: root });

  const showDiff = useCallback(
    async (f: GitFile, staged: boolean) => {
      const abs = joinPath(root, f.path);
      try {
        const original = await gitApi.show(root, "HEAD", f.path);
        const modified = staged
          ? await gitApi.show(root, ":", f.path) // index version
          : await fs.readFile(abs);
        requestDiff({
          path: f.path,
          refspec: staged ? "HEAD vs index" : "HEAD vs working tree",
          originalContent: original,
          modifiedContent: modified,
          language: langOf(f.path),
        });
      } catch (e) {
        toastError(`Diff failed: ${e}`);
      }
    },
    [root],
  );

  const loadBranches = useCallback(async () => {
    try {
      const list = await gitApi.branches(root);
      setBranches(list);
    } catch {
      setBranches([]);
    }
  }, [root]);

  useEffect(() => {
    void loadBranches();
  }, [loadBranches, status?.branch]);

  const switchBranch = useCallback(
    async (b: string) => {
      setBranchOpen(false);
      try {
        await gitApi.checkoutBranch(root, b);
        toastSuccess(`Switched to ${b}`);
        await refresh();
      } catch (e) {
        toastError(`Checkout failed: ${e}`);
      }
    },
    [root, refresh],
  );

  const discard = useCallback(
    async (f: GitFile) => {
      const ok = await dialogConfirm(
        `Discard changes to ${f.path}?\n\nThis cannot be undone.`,
        {
          title: "Discard changes",
          okLabel: "Discard",
          cancelLabel: "Keep",
          danger: true,
        },
      );
      if (!ok) return;
      try {
        await gitApi.discard(root, [f.path]);
        toastSuccess(`Discarded changes to ${f.path}`);
        await refresh();
      } catch (e) {
        toastError(`Discard failed: ${e}`);
      }
    },
    [root, refresh],
  );

  if (!status) {
    return <div className="git-panel"><div className="muted" style={{padding: 12}}>Loading…</div></div>;
  }
  if (!status.is_repo) {
    return (
      <div className="git-panel">
        <div className="muted" style={{ padding: 12 }}>
          Not a git repository.
          <div style={{ marginTop: 8 }}>
            <button
              onClick={() =>
                run("Initializing", "git_init", { path: root })
              }
            >
              Initialize repo
            </button>
          </div>
        </div>
        {log && <pre className="git-log">{log}</pre>}
      </div>
    );
  }

  const staged = status.files.filter((f) => f.staged);
  const changes = status.files.filter((f) => !f.staged);

  return (
    <div className="git-panel">
      <div className="git-header">
        <div className="git-branch-row">
          <button
            className="git-branch"
            title={
              status.upstream
                ? `Tracking ${status.upstream} — click to switch branch`
                : "No upstream — click to switch branch"
            }
            onClick={() => setBranchOpen((v) => !v)}
          >
            ⎇ {status.branch ?? "(detached)"}
            {status.ahead > 0 ? (
              <span className="git-ahead"> ↑{status.ahead}</span>
            ) : null}
            {status.behind > 0 ? (
              <span className="git-behind"> ↓{status.behind}</span>
            ) : null}
            <span className="git-branch-caret">▾</span>
          </button>
          {branchOpen && (
            <>
              <div
                className="menu-overlay"
                onMouseDown={() => setBranchOpen(false)}
              />
              <div className="git-branch-menu">
                {branches.length === 0 && (
                  <div
                    className="menu-section-title"
                    style={{ padding: 8 }}
                  >
                    No branches
                  </div>
                )}
                {branches.map((b) => (
                  <button
                    key={b}
                    className={`menu-item ${
                      b === status.branch ? "active" : ""
                    }`}
                    onClick={() => void switchBranch(b)}
                  >
                    <span className="menu-item-label">{b}</span>
                    {b === status.branch && (
                      <span className="menu-item-accel">current</span>
                    )}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="git-actions">
          <button
            onClick={() => void refresh()}
            title="Refresh"
            aria-label="Refresh git status"
          >
            ⟳
          </button>
          <button
            onClick={() => void fetch_()}
            disabled={!!busy}
            title="Fetch"
          >
            Fetch
          </button>
          <button
            onClick={() => void pull()}
            disabled={!!busy}
            title="Pull"
          >
            Pull
          </button>
          <button
            onClick={() => void push()}
            disabled={!!busy}
            title="Push"
          >
            Push
          </button>
        </div>
      </div>

      <div className="git-commit">
        <textarea
          rows={2}
          placeholder="Commit message · Ctrl+Enter to commit"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            // Match the muscle memory people bring from VS Code's source
            // control: Ctrl/Cmd+Enter inside the message box runs the
            // commit if there are staged files. Plain Enter still adds
            // a newline since most messages are >1 line.
            if (
              (e.ctrlKey || e.metaKey) &&
              e.key === "Enter" &&
              !busy &&
              message.trim() &&
              staged.length > 0
            ) {
              e.preventDefault();
              void commit();
            }
          }}
        />
        <div className="git-commit-actions">
          <button
            className="primary"
            onClick={() => void commit()}
            disabled={!!busy || !message.trim() || staged.length === 0}
            title={
              staged.length === 0
                ? "Stage at least one file first"
                : !message.trim()
                  ? "Type a commit message"
                  : "Commit staged changes (Ctrl+Enter from message box)"
            }
          >
            Commit
          </button>
          <button onClick={() => void stageAll()} disabled={!!busy}>
            Stage all
          </button>
        </div>
      </div>

      <div className="git-section-title">
        Staged ({staged.length})
      </div>
      <ul className="git-files">
        {staged.map((f) => (
          <li
            key={"s:" + f.path}
            onClick={() => void showDiff(f, true)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx({ x: e.clientX, y: e.clientY, file: f });
            }}
          >
            <span
              className="git-status-tag"
              style={{ color: statusColor(f) }}
            >
              {statusLabel(f)}
            </span>
            <span className="git-file-path" title={f.path}>
              {f.path}
            </span>
            <button
              className="git-file-action"
              onClick={(e) => {
                e.stopPropagation();
                void unstage(f.path);
              }}
              title="Unstage"
            >
              −
            </button>
          </li>
        ))}
      </ul>

      <div className="git-section-title">
        Changes ({changes.length})
      </div>
      <ul className="git-files">
        {changes.map((f) => (
          <li
            key={"c:" + f.path}
            onClick={() => void showDiff(f, false)}
            onContextMenu={(e) => {
              e.preventDefault();
              setCtx({ x: e.clientX, y: e.clientY, file: f });
            }}
          >
            <span
              className="git-status-tag"
              style={{ color: statusColor(f) }}
            >
              {statusLabel(f)}
            </span>
            <span className="git-file-path" title={f.path}>
              {f.path}
            </span>
            <button
              className="git-file-action"
              onClick={(e) => {
                e.stopPropagation();
                void stage(f.path);
              }}
              title="Stage"
            >
              +
            </button>
          </li>
        ))}
      </ul>

      {busy && <div className="git-busy">{busy}…</div>}
      {log && <pre className="git-log">{log}</pre>}
      {ctx && (
        <ContextMenu
          x={ctx.x}
          y={ctx.y}
          items={(() => {
            const file = ctx.file;
            const items: (ContextMenuItem | "separator")[] = [];
            items.push({
              label: "View Diff",
              onClick: () => showDiff(file, file.staged),
            });
            if (file.staged) {
              items.push({
                label: "Unstage",
                onClick: () => unstage(file.path),
              });
            } else {
              items.push({
                label: "Stage",
                onClick: () => stage(file.path),
              });
            }
            items.push("separator");
            items.push({
              label: "Discard Changes",
              danger: true,
              disabled: file.staged,
              onClick: () => discard(file),
            });
            items.push({
              label: "Copy Path",
              onClick: async () => {
                try {
                  await navigator.clipboard.writeText(file.path);
                } catch {
                  /* ignore */
                }
              },
            });
            return items;
          })()}
          onClose={() => setCtx(null)}
        />
      )}
    </div>
  );
}
