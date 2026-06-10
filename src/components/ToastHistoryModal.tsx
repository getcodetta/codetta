// Scrollable log of every toast surfaced this session. Toasts auto-dismiss
// after 4-8 seconds depending on kind, which is fine for the success +
// info case ("File saved") but means errors that fire in a tight burst
// (failing watcher, AI 429s) scroll past faster than the user can read
// them. This modal is the recovery path: open via the "Show Notifications"
// palette command and read everything that scrolled by.
//
// We mirror ShortcutReferenceModal's chrome (same backdrop, same Esc /
// outside-click dismissal, same filter input) so users who already know
// one modal know this one.
//
// Live-subscribe: while the modal is open, new toasts append to the
// visible list immediately. That way an error that fires WHILE the user
// is reading shows up without them having to close + reopen.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  clearToastHistory,
  getToastHistory,
  subscribeToastHistory,
  type ToastRecord,
} from "../notify";
import { useModalFocus } from "../useModalFocus";
import { Icon, type IconName } from "./Icon";

interface Props {
  open: boolean;
  onClose: () => void;
}

const KIND_LABEL: Record<ToastRecord["kind"], string> = {
  info: "Info",
  success: "Success",
  warning: "Warning",
  error: "Error",
};

const KIND_ICON: Record<ToastRecord["kind"], IconName> = {
  info: "info",
  success: "check",
  warning: "alert-triangle",
  error: "x-circle",
};

const KIND_COLOR: Record<ToastRecord["kind"], string> = {
  // Match the toast-* CSS palette in App.css — using inline colours here
  // rather than pulling new CSS classes keeps the modal self-contained
  // and avoids duplicating selectors that already exist for the toast
  // stack.
  info: "var(--accent, #4a9eff)",
  success: "var(--success, #4ade80)",
  warning: "var(--warning, #facc15)",
  error: "var(--error, #f87171)",
};

function formatTimestamp(ts: number, now: number): string {
  // < 60s: "just now". Past that and same calendar day: "5m ago" / "2h ago".
  // Different day from today: "Mon 14:32" so the row still answers "when".
  // The grouping header upstream handles the "yesterday vs today" framing
  // for cross-day spans, so the per-row label only needs the granular bit.
  const delta = Math.max(0, now - ts);
  const sec = Math.floor(delta / 1000);
  if (sec < 60) return "just now";
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const d = new Date(ts);
  return d.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function dateLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date(today);
  yesterday.setDate(today.getDate() - 1);
  const sameDay = (a: Date, b: Date) =>
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate();
  if (sameDay(d, today)) return "Today";
  if (sameDay(d, yesterday)) return "Yesterday";
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });
}

export function ToastHistoryModal({ open, onClose }: Props) {
  const [query, setQuery] = useState("");
  const modalRef = useRef<HTMLDivElement | null>(null);
  useModalFocus(modalRef, open);
  // Re-render trigger — we don't store the records in state directly,
  // we just bump a version number whenever the history changes and let
  // useMemo recompute from the source of truth.
  const [, setVersion] = useState(0);
  // Recompute "5m ago" labels every 30s so they stay roughly accurate
  // while the modal is open, without burning cycles on a per-second tick.
  const [now, setNow] = useState(() => Date.now());

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

  useEffect(() => {
    if (!open) return;
    // Refresh on each new toast so the modal stays live while open.
    const off = subscribeToastHistory(() => setVersion((v) => v + 1));
    const t = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => {
      off();
      window.clearInterval(t);
    };
  }, [open]);

  const all = useMemo(() => getToastHistory(), [open, query, now]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return all;
    return all.filter((r) => {
      if (r.message.toLowerCase().includes(q)) return true;
      if (KIND_LABEL[r.kind].toLowerCase().includes(q)) return true;
      return false;
    });
  }, [all, query]);

  // Group by day only when the visible records actually span more than
  // one calendar day. Most sessions are one-day; flat list reads cleaner
  // there. Long-running editors that span midnight get the headers.
  const grouped = useMemo(() => {
    if (filtered.length === 0) return [];
    const days = new Set<string>();
    for (const r of filtered) {
      const d = new Date(r.ts);
      days.add(`${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`);
      if (days.size > 1) break;
    }
    if (days.size <= 1) {
      return [{ label: "", items: filtered }];
    }
    const groups: Array<{ label: string; items: ToastRecord[] }> = [];
    for (const r of filtered) {
      const label = dateLabel(r.ts);
      const tail = groups[groups.length - 1];
      if (tail && tail.label === label) {
        tail.items.push(r);
      } else {
        groups.push({ label, items: [r] });
      }
    }
    return groups;
  }, [filtered]);

  if (!open) return null;

  return createPortal(
    <div className="shortcut-modal-backdrop" onMouseDown={onClose}>
      <div
        ref={modalRef}
        tabIndex={-1}
        className="shortcut-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Notifications"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="shortcut-modal-header">
          <div
            className="shortcut-modal-title"
            style={{ display: "flex", alignItems: "center", gap: 12 }}
          >
            <span>Notifications</span>
            <span style={{ fontSize: 12, opacity: 0.6, fontWeight: 400 }}>
              {all.length} this session
            </span>
            {all.length > 0 && (
              <button
                type="button"
                onClick={() => clearToastHistory()}
                style={{
                  background: "none",
                  border: "none",
                  padding: 0,
                  color: "var(--accent, #4a9eff)",
                  fontSize: 12,
                  cursor: "pointer",
                  textDecoration: "underline",
                }}
              >
                Clear
              </button>
            )}
          </div>
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
          placeholder="Filter by message or kind…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <div className="shortcut-modal-body">
          {all.length === 0 && (
            <div className="shortcut-modal-empty">No notifications yet.</div>
          )}
          {all.length > 0 && filtered.length === 0 && (
            <div className="shortcut-modal-empty">
              No notifications match that filter.
            </div>
          )}
          {grouped.map((g, gi) => (
            <section
              key={`${g.label}-${gi}`}
              className="shortcut-modal-group"
            >
              {g.label && (
                <h3 className="shortcut-modal-group-title">{g.label}</h3>
              )}
              <div style={{ display: "flex", flexDirection: "column" }}>
                {g.items.map((r) => (
                  <div
                    key={r.id}
                    style={{
                      display: "flex",
                      alignItems: "flex-start",
                      gap: 8,
                      padding: "6px 4px",
                      borderBottom: "1px solid var(--border, #2a2a2a)",
                    }}
                  >
                    <span
                      title={KIND_LABEL[r.kind]}
                      aria-label={KIND_LABEL[r.kind]}
                      style={{
                        color: KIND_COLOR[r.kind],
                        display: "inline-flex",
                        alignItems: "center",
                        flexShrink: 0,
                        marginTop: 2,
                      }}
                    >
                      <Icon name={KIND_ICON[r.kind]} size={14} />
                    </span>
                    <span
                      style={{
                        flex: 1,
                        whiteSpace: "pre-wrap",
                        wordBreak: "break-word",
                        fontSize: 13,
                      }}
                    >
                      {r.message}
                    </span>
                    <span
                      title={new Date(r.ts).toLocaleString()}
                      style={{
                        flexShrink: 0,
                        fontSize: 11,
                        opacity: 0.6,
                        fontVariantNumeric: "tabular-nums",
                        marginTop: 3,
                      }}
                    >
                      {formatTimestamp(r.ts, now)}
                    </span>
                  </div>
                ))}
              </div>
            </section>
          ))}
        </div>
      </div>
    </div>,
    document.body,
  );
}
