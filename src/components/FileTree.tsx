import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { fs, type DirEntry } from "../ipc";
import { fsBus, pathsEqual } from "../fsBus";
import { findTabsPaneByTab, useStore } from "../store";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import {
  error as toastError,
  success as toastSuccess,
} from "../notify";
import {
  confirm as dialogConfirm,
  prompt as dialogPrompt,
} from "../dialog";
import {
  getActiveSftp,
  lookupRemoteLink,
  rememberRemoteLink,
  subscribeActiveSftp,
} from "../sftpLinks";

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function dirname(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const i = norm.lastIndexOf("/");
  return i > 0 ? norm.slice(0, i) : norm;
}

function joinPath(base: string, name: string): string {
  const norm = base.replace(/\\/g, "/").replace(/\/+$/, "");
  return `${norm}/${name}`;
}

interface MenuTarget {
  x: number;
  y: number;
  entry: DirEntry | null; // null = root background
}

interface NodeProps {
  wsId: string;
  entry: DirEntry;
  depth: number;
  onContext: (target: MenuTarget) => void;
}

function Node({ wsId, entry, depth, onContext }: NodeProps) {
  const expanded = useStore((s) =>
    (s.loaded[wsId]?.layout.expandedDirs ?? []).includes(entry.path),
  );
  const toggleDir = useStore((s) => s.toggleDir);
  const openFile = useStore((s) => s.openFile);
  const isActive = useStore((s) => {
    if (entry.is_dir) return false;
    const layout = s.loaded[wsId]?.layout;
    if (!layout) return false;
    const key = "file:" + entry.path;
    const ePane = findTabsPaneByTab(layout.editorRoot, key);
    if (ePane && ePane.active === key) return true;
    if (
      layout.bottomRoot &&
      findTabsPaneByTab(layout.bottomRoot, key)?.active === key
    ) {
      return true;
    }
    return false;
  });
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    if (!entry.is_dir) return;
    setLoading(true);
    fs.listDir(entry.path)
      .then((c) => setChildren(c))
      .catch(() => setChildren([]))
      .finally(() => setLoading(false));
  }, [entry]);

  useEffect(() => {
    if (entry.is_dir && expanded && children === null && !loading) {
      refresh();
    }
  }, [expanded, entry, children, loading, refresh]);

  useEffect(() => {
    if (!entry.is_dir) return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as {
        wsId: string;
        dir: string;
      };
      if (detail.wsId !== wsId) return;
      if (pathsEqual(detail.dir, entry.path)) {
        if (expanded) refresh();
        else setChildren(null);
      }
    };
    fsBus.addEventListener("dir", handler);
    return () => fsBus.removeEventListener("dir", handler);
  }, [entry, wsId, expanded, refresh]);

  const onClick = () => {
    if (entry.is_dir) toggleDir(wsId, entry.path);
    else void openFile(wsId, entry.path);
  };

  return (
    <>
      <div
        className={`tree-row ${isActive ? "active" : ""}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={onClick}
        onContextMenu={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onContext({ x: e.clientX, y: e.clientY, entry });
        }}
        title={entry.path}
      >
        <span className="tree-caret">
          {entry.is_dir ? (expanded ? "▾" : "▸") : ""}
        </span>
        <span className="tree-icon">{entry.is_dir ? "📁" : "📄"}</span>
        <span className="tree-name">{entry.name}</span>
      </div>
      {entry.is_dir && expanded && children && (
        <>
          {children.map((c) => (
            <Node
              key={c.path}
              wsId={wsId}
              entry={c}
              depth={depth + 1}
              onContext={onContext}
            />
          ))}
        </>
      )}
    </>
  );
}

interface Props {
  wsId: string;
  root: string;
}

export function FileTree({ wsId, root }: Props) {
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  // Subscribe to the active SFTP session so the right-click menu can
  // light up "Push" / "Upload to remote" entries when a connection is
  // live. Stored as a tick counter — we only need to re-render, the
  // real value is read on-demand inside the menu builder via getActiveSftp.
  const [, setSftpTick] = useState(0);
  useEffect(() => {
    return subscribeActiveSftp(wsId, () => setSftpTick((n) => n + 1));
  }, [wsId]);

  const refresh = useCallback(() => {
    fs.listDir(root)
      .then((e) => setEntries(e))
      .catch(() => setEntries([]));
  }, [root]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  useEffect(() => {
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent).detail as {
        wsId: string;
        dir: string;
      };
      if (detail.wsId !== wsId) return;
      if (pathsEqual(detail.dir, root)) refresh();
    };
    fsBus.addEventListener("dir", handler);
    return () => fsBus.removeEventListener("dir", handler);
  }, [wsId, root, refresh]);

  const items: (ContextMenuItem | "separator")[] = (() => {
    const target = menu?.entry ?? null;
    const parentPath =
      target == null ? root : target.is_dir ? target.path : dirname(target.path);

    const out: (ContextMenuItem | "separator")[] = [];
    out.push({
      label: "New File…",
      onClick: async () => {
        const name = await dialogPrompt("New file name", "", {
          title: "New file",
          okLabel: "Create",
        });
        if (!name) return;
        const p = joinPath(parentPath, name);
        try {
          await fs.createFile(p);
          await useStore.getState().openFile(wsId, p);
        } catch (e) {
          toastError(`Failed to create file: ${e}`);
        }
      },
    });
    out.push({
      label: "New Folder…",
      onClick: async () => {
        const name = await dialogPrompt("New folder name", "", {
          title: "New folder",
          okLabel: "Create",
        });
        if (!name) return;
        const p = joinPath(parentPath, name);
        try {
          await fs.createDir(p);
        } catch (e) {
          toastError(`Failed to create folder: ${e}`);
        }
      },
    });
    if (target) {
      out.push("separator");
      out.push({
        label: "Rename…",
        onClick: async () => {
          const next = await dialogPrompt(
            "Rename to",
            basename(target.path),
            { title: "Rename", okLabel: "Rename" },
          );
          if (!next || next === basename(target.path)) return;
          const newPath = joinPath(dirname(target.path), next);
          try {
            await fs.rename(target.path, newPath);
          } catch (e) {
            toastError(`Failed to rename: ${e}`);
          }
        },
      });
      out.push({
        label: "Delete",
        danger: true,
        onClick: async () => {
          // The Rust delete_path does remove_dir_all for directories,
          // which is a recursive nuke — surface that explicitly so a
          // stray right-click on a folder can't silently take out a
          // big subtree.
          const message = target.is_dir
            ? `Delete folder ${basename(target.path)} and ALL its contents?\n\nThis is recursive and cannot be undone.`
            : `Delete ${basename(target.path)}?\n\nThis cannot be undone.`;
          const ok = await dialogConfirm(message, {
            title: target.is_dir ? "Delete folder" : "Delete file",
            okLabel: "Delete",
            cancelLabel: "Cancel",
            danger: true,
          });
          if (!ok) return;
          try {
            await fs.delete(target.path);
          } catch (e) {
            toastError(`Failed to delete: ${e}`);
          }
        },
      });
      out.push("separator");
      out.push({
        label: "Reveal in File Explorer",
        onClick: async () => {
          try {
            await revealItemInDir(target.path);
          } catch (e) {
            console.error(e);
          }
        },
      });
      out.push({
        label: "Copy Path",
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(target.path);
          } catch {
            /* ignore */
          }
        },
      });
      out.push({
        label: "Copy Relative Path",
        onClick: async () => {
          // Workspace-relative path with forward slashes — what most
          // tools (grep, git pathspec, AI prompts pasted into chat)
          // expect when you say "the foo/bar.ts file." Mirrors VS
          // Code's same-named entry. Falls back to absolute if the
          // file somehow sits outside root.
          const norm = target.path.replace(/\\/g, "/");
          const r = root.replace(/\\/g, "/").replace(/\/+$/, "") + "/";
          const rel = norm.startsWith(r) ? norm.slice(r.length) : norm;
          try {
            await navigator.clipboard.writeText(rel);
            toastSuccess(`Copied: ${rel}`);
          } catch {
            /* ignore */
          }
        },
      });

      // SFTP actions. Files get push/upload/auto-push toggle; folders
      // get a recursive upload entry. Both kinds light up only when a
      // session is connected (via the active-SFTP registry).
      if (target.is_dir) {
        const active = getActiveSftp(wsId);
        if (active) {
          out.push("separator");
          out.push({
            label: `Upload folder to remote (${active.cwd})…`,
            onClick: async () => {
              const suggestedRemote = `${active.cwd.replace(/\/$/, "")}/${basename(target.path)}`;
              const remotePath = await dialogPrompt(
                "Remote target folder",
                suggestedRemote,
                {
                  title: "Upload folder (recursive)",
                  okLabel: "Upload",
                },
              );
              if (!remotePath) return;
              const ok = await dialogConfirm(
                `Upload contents of:\n  ${target.path}\n→ remote:\n  ${remotePath}\n\nHeavy dirs (.git, node_modules, dist…) are skipped.`,
                {
                  title: "Confirm upload",
                  okLabel: "Upload",
                  cancelLabel: "Cancel",
                },
              );
              if (!ok) return;
              try {
                const result = await invoke<{
                  files: number;
                  bytes: number;
                  failed: string[];
                }>("sftp_upload_dir", {
                  args: {
                    ...active.conn,
                    local_path: target.path,
                    remote_path: remotePath,
                  },
                });
                const mb = (result.bytes / 1024 / 1024).toFixed(2);
                if (result.failed.length === 0) {
                  toastSuccess(
                    `Uploaded ${result.files} files (${mb} MB) → ${remotePath}`,
                  );
                } else {
                  toastError(
                    `Uploaded ${result.files}/${
                      result.files + result.failed.length
                    } files. ${result.failed.length} failed — see console.`,
                  );
                  console.warn(
                    "sftp_upload_dir failures:",
                    result.failed,
                  );
                }
              } catch (e) {
                toastError(
                  `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            },
          });
        }
      } else {
        const link = lookupRemoteLink(wsId, target.path);
        const active = getActiveSftp(wsId);
        if (link || active) {
          out.push("separator");
        }
        if (link) {
          out.push({
            label: link.autoPush
              ? "Disable auto-push on save"
              : "Enable auto-push on save",
            onClick: () => {
              rememberRemoteLink(wsId, target.path, {
                ...link,
                autoPush: !link.autoPush,
              });
              toastSuccess(
                link.autoPush
                  ? `Auto-push disabled for ${basename(target.path)}`
                  : `Auto-push ON for ${basename(target.path)} → saves push to ${link.remotePath}`,
              );
            },
          });
          out.push({
            label: `Push to remote (${link.remotePath})`,
            onClick: async () => {
              try {
                const contents = await fs.readFile(target.path);
                await invoke("sftp_write_file", {
                  args: {
                    ...(active?.profileId === link.profileId
                      ? active.conn
                      : null),
                    path: link.remotePath,
                    contents,
                  },
                });
                rememberRemoteLink(wsId, target.path, {
                  ...link,
                  downloadedAt: Date.now(),
                });
                toastSuccess(`Pushed → ${link.remotePath}`);
              } catch (e) {
                toastError(
                  `Push failed: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            },
          });
        }
        if (active) {
          out.push({
            label: `Upload to remote (${active.cwd})…`,
            onClick: async () => {
              const suggested = `${active.cwd.replace(/\/$/, "")}/${basename(target.path)}`;
              const remotePath = await dialogPrompt(
                "Remote target path",
                suggested,
                { title: "Upload to remote", okLabel: "Upload" },
              );
              if (!remotePath) return;
              try {
                const contents = await fs.readFile(target.path);
                await invoke("sftp_write_file", {
                  args: { ...active.conn, path: remotePath, contents },
                });
                rememberRemoteLink(wsId, target.path, {
                  profileId: active.profileId,
                  remotePath,
                  downloadedAt: Date.now(),
                });
                toastSuccess(`Uploaded → ${remotePath}`);
              } catch (e) {
                toastError(
                  `Upload failed: ${e instanceof Error ? e.message : String(e)}`,
                );
              }
            },
          });
        }
      }
    }
    return out;
  })();

  return (
    <div
      className="tree"
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY, entry: null });
      }}
    >
      {entries.map((e) => (
        <Node
          key={e.path}
          wsId={wsId}
          entry={e}
          depth={0}
          onContext={(t) => setMenu(t)}
        />
      ))}
      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={items}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}
