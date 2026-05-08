// Glance-able cheatsheet of every registered command + its keyboard
// accelerator. Opens with F1; the command palette already lets users
// run a command, but this modal answers the different question
// "what shortcuts exist?" without forcing a search query.
//
// Source of truth is the same `commands` array the palette reads
// from, so any new command automatically shows up here once it's
// registered.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { commands } from "../actions";
import { Icon } from "./Icon";

interface Props {
  open: boolean;
  onClose: () => void;
}

const CATEGORY_ORDER = [
  "File",
  "Edit",
  "View",
  "Workspace",
  "Terminal",
  "AI",
  "Help",
] as const;

export function ShortcutReferenceModal({ open, onClose }: Props) {
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!open) {
      setQuery("");
      return;
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matchesQuery = (c: { label: string; accel?: string; id: string }) =>
      !q ||
      c.label.toLowerCase().includes(q) ||
      (c.accel && c.accel.toLowerCase().includes(q)) ||
      c.id.toLowerCase().includes(q);
    const map = new Map<string, typeof commands>();
    for (const c of commands) {
      if (!matchesQuery(c)) continue;
      const list = map.get(c.category) ?? [];
      list.push(c);
      map.set(c.category, list);
    }
    return CATEGORY_ORDER.filter((cat) => map.has(cat)).map((cat) => ({
      category: cat,
      // Within each category, accel'd commands first then the rest,
      // alphabetical inside each group — keeps the reference scannable.
      items: (map.get(cat) ?? []).sort((a, b) => {
        if (!!a.accel !== !!b.accel) return a.accel ? -1 : 1;
        return a.label.localeCompare(b.label);
      }),
    }));
  }, [query]);

  if (!open) return null;

  return createPortal(
    <div className="shortcut-modal-backdrop" onMouseDown={onClose}>
      <div
        className="shortcut-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard Shortcuts"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shortcut-modal-header">
          <div className="shortcut-modal-title">Keyboard Shortcuts</div>
          <button
            className="shortcut-modal-close"
            onClick={onClose}
            aria-label="Close"
            title="Close (Esc)"
          >
            <Icon name="x" size={14} />
          </button>
        </div>
        <input
          autoFocus
          className="shortcut-modal-filter"
          type="text"
          placeholder="Filter by command, shortcut, or id…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="shortcut-modal-body">
          {groups.length === 0 && (
            <div className="shortcut-modal-empty">No matching commands</div>
          )}
          {groups.map((g) => (
            <section key={g.category} className="shortcut-modal-group">
              <h3 className="shortcut-modal-group-title">{g.category}</h3>
              <table className="shortcut-modal-table">
                <tbody>
                  {g.items.map((c) => (
                    <tr key={c.id}>
                      <td className="shortcut-modal-label">{c.label}</td>
                      <td className="shortcut-modal-accel">
                        {c.accel ? (
                          <kbd>{c.accel}</kbd>
                        ) : (
                          <span className="shortcut-modal-noaccel">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
