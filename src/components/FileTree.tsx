import { useEffect, useState } from "react";
import { fs, type DirEntry } from "../ipc";
import { useStore } from "../store";

interface NodeProps {
  entry: DirEntry;
  depth: number;
}

function Node({ entry, depth }: NodeProps) {
  const expanded = useStore((s) =>
    s.loadedWorkspaceState.expandedDirs.includes(entry.path),
  );
  const toggleDir = useStore((s) => s.toggleDir);
  const openFile = useStore((s) => s.openFile);
  const activeTab = useStore((s) => s.loadedWorkspaceState.activeTab);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (entry.is_dir && expanded && children === null && !loading) {
      setLoading(true);
      fs.listDir(entry.path)
        .then((c) => setChildren(c))
        .catch(() => setChildren([]))
        .finally(() => setLoading(false));
    }
  }, [expanded, entry, children, loading]);

  const onClick = () => {
    if (entry.is_dir) {
      toggleDir(entry.path);
    } else {
      void openFile(entry.path);
    }
  };

  const isActive = !entry.is_dir && activeTab === entry.path;

  return (
    <>
      <div
        className={`tree-row ${isActive ? "active" : ""}`}
        style={{ paddingLeft: 6 + depth * 12 }}
        onClick={onClick}
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
            <Node key={c.path} entry={c} depth={depth + 1} />
          ))}
        </>
      )}
    </>
  );
}

export function FileTree({ root }: { root: string }) {
  const [entries, setEntries] = useState<DirEntry[]>([]);

  useEffect(() => {
    let alive = true;
    fs.listDir(root)
      .then((e) => {
        if (alive) setEntries(e);
      })
      .catch(() => setEntries([]));
    return () => {
      alive = false;
    };
  }, [root]);

  return (
    <div className="tree">
      {entries.map((e) => (
        <Node key={e.path} entry={e} depth={0} />
      ))}
    </div>
  );
}
