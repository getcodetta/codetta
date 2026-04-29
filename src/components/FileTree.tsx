import { useCallback, useEffect, useState } from "react";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { fs, type DirEntry } from "../ipc";
import { fsBus, pathsEqual } from "../fsBus";
import { findTabsPaneByTab, useStore } from "../store";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { error as toastError } from "../notify";
import {
  confirm as dialogConfirm,
  prompt as dialogPrompt,
} from "../dialog";

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
          const ok = await dialogConfirm(
            `Delete ${basename(target.path)}?\n\nThis cannot be undone.`,
            {
              title: "Delete",
              okLabel: "Delete",
              cancelLabel: "Cancel",
              danger: true,
            },
          );
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
