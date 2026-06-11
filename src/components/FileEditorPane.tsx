// Inline single-file editor (textarea) used inside the Agent
// Customizations modal — for the workspace instructions file and for a
// skill's SKILL.md. Deliberately a plain <textarea>: Monaco is overkill
// for a markdown blob and fragile to mount in a transient surface.

import { useEffect, useRef, useState } from "react";
import { fs } from "../ipc";
import { dirname } from "../pathUtils";
import { confirm as dialogConfirm } from "../dialog";
import { success as toastSuccess, error as toastError, errMsg } from "../notify";
import { Icon } from "./Icon";

interface Props {
  /** Absolute path of the file to edit. */
  path: string | null;
  /** Sub-heading, e.g. the workspace-relative path. */
  subtitle?: string;
  /** Seed content used when the file doesn't exist yet. */
  starter?: string;
  /** When set, renders a back button (e.g. return to the skills list). */
  onBack?: () => void;
  /** Heading shown next to the back button. */
  title?: string;
  /** Reports unsaved-edit state so a host can guard close. */
  onDirtyChange?: (dirty: boolean) => void;
}

export function FileEditorPane({
  path,
  subtitle,
  starter,
  onBack,
  title,
  onDirtyChange,
}: Props) {
  const [content, setContent] = useState("");
  const [original, setOriginal] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const dirty = content !== original;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  // Surface dirty state to the host (modal guards its close on it), and
  // clear it on unmount so a stale "unsaved" flag can't block closing.
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    return () => onDirtyChange?.(false);
  }, [onDirtyChange]);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    (async () => {
      let text = starter ?? "";
      try {
        if (await fs.exists(path)) text = await fs.readFile(path);
      } catch (e) {
        console.warn("FileEditorPane load failed", e);
      }
      if (!alive) return;
      setContent(text);
      setOriginal(text);
      setLoading(false);
    })();
    return () => {
      alive = false;
    };
  }, [path, starter]);

  const save = async () => {
    if (!path) return;
    setSaving(true);
    try {
      await fs.writeFile(path, content);
    } catch {
      try {
        await fs.createDir(dirname(path));
        await fs.writeFile(path, content);
      } catch (e2) {
        setSaving(false);
        toastError(`Could not save: ${errMsg(e2)}`);
        return;
      }
    }
    setSaving(false);
    setOriginal(content);
    toastSuccess("Saved");
  };

  const back = async () => {
    if (!onBack) return;
    if (dirtyRef.current) {
      const ok = await dialogConfirm("Discard unsaved changes?", {
        okLabel: "Discard",
        cancelLabel: "Keep editing",
        danger: true,
      });
      if (!ok) return;
    }
    onBack();
  };

  // Ctrl+S saves while this pane is mounted.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        if (dirtyRef.current) void save();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content, path]);

  return (
    <div className="cust-editor">
      {(onBack || subtitle) && (
        <div className="cust-editor-bar">
          {onBack && (
            <button className="cust-back" onClick={() => void back()}>
              <Icon name="chevron-left" size={12} />
              <span>{title ?? "Back"}</span>
            </button>
          )}
          {subtitle && <span className="cust-editor-path">{subtitle}</span>}
        </div>
      )}
      <textarea
        className="cust-editor-textarea"
        value={loading ? "" : content}
        placeholder={loading ? "Loading…" : ""}
        spellCheck={false}
        disabled={loading || !path}
        onChange={(e) => setContent(e.target.value)}
      />
      <div className="cust-editor-foot">
        <span className="cust-foot-hint">
          {dirty ? "Unsaved changes" : "Saved"} · Ctrl+S to save
        </span>
        <button
          className="cust-btn primary"
          onClick={() => void save()}
          disabled={!dirty || saving}
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
    </div>
  );
}
