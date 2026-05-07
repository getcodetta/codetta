import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface ContextMenuItem {
  label: string;
  onClick: () => void | Promise<void>;
  danger?: boolean;
  disabled?: boolean;
}

interface Props {
  x: number;
  y: number;
  items: (ContextMenuItem | "separator")[];
  onClose: () => void;
}

export function ContextMenu({ x, y, items, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement | null>(null);
  // Initial guess; corrected after the first measurement.
  const [pos, setPos] = useState<{ left: number; top: number }>(() => {
    const maxX = window.innerWidth - 220;
    const maxY = window.innerHeight - 8;
    return {
      left: Math.max(4, Math.min(x, maxX)),
      top: Math.max(4, Math.min(y, maxY)),
    };
  });

  // Indices of focusable (non-separator, non-disabled) items, used by
  // the keyboard navigation block below to skip over separators and
  // greyed-out entries cleanly.
  const enabledIndexes = items
    .map((it, i) => (it !== "separator" && !it.disabled ? i : -1))
    .filter((i) => i >= 0);

  const focusItem = (idx: number) => {
    const el = menuRef.current?.querySelector<HTMLButtonElement>(
      `button[data-ctx-idx="${idx}"]`,
    );
    el?.focus();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      if (enabledIndexes.length === 0) return;
      // Find which enabled item currently has focus to compute the next
      // one. document.activeElement is the focused button when the menu
      // is keyboard-driven; falls back to "first item" when nothing in
      // the menu has focus yet (e.g. menu opened via right-click).
      const active = document.activeElement as HTMLElement | null;
      const activeIdx = active?.dataset.ctxIdx
        ? Number(active.dataset.ctxIdx)
        : -1;
      const cur = enabledIndexes.indexOf(activeIdx);
      if (e.key === "ArrowDown") {
        e.preventDefault();
        const next = cur < 0 ? 0 : (cur + 1) % enabledIndexes.length;
        focusItem(enabledIndexes[next]);
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        const next =
          cur < 0
            ? enabledIndexes.length - 1
            : (cur - 1 + enabledIndexes.length) % enabledIndexes.length;
        focusItem(enabledIndexes[next]);
      } else if (e.key === "Home") {
        e.preventDefault();
        focusItem(enabledIndexes[0]);
      } else if (e.key === "End") {
        e.preventDefault();
        focusItem(enabledIndexes[enabledIndexes.length - 1]);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, enabledIndexes]);

  // Move focus to the first enabled item on open so arrow keys work
  // immediately. Wait one frame so the layout pass has placed the menu;
  // .focus() before that occasionally scrolls the menu into a weird
  // initial position on Chromium.
  useEffect(() => {
    if (enabledIndexes.length === 0) return;
    const id = window.requestAnimationFrame(() => {
      focusItem(enabledIndexes[0]);
    });
    return () => window.cancelAnimationFrame(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Measure once after mount and reposition so the menu always fits in the
  // viewport. If it would overflow the bottom, anchor it ABOVE the click
  // (so the user sees all entries even when right-clicking near the
  // bottom of a small terminal pane).
  useLayoutEffect(() => {
    const el = menuRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const margin = 4;
    let nextLeft = x;
    let nextTop = y;
    if (nextLeft + rect.width + margin > window.innerWidth) {
      // Flip horizontally if there's not enough room to the right.
      nextLeft = Math.max(margin, x - rect.width);
    }
    if (nextTop + rect.height + margin > window.innerHeight) {
      // Try opening above the click.
      const above = y - rect.height;
      nextTop = above >= margin
        ? above
        : Math.max(margin, window.innerHeight - rect.height - margin);
    }
    nextLeft = Math.max(margin, nextLeft);
    nextTop = Math.max(margin, nextTop);
    if (nextLeft !== pos.left || nextTop !== pos.top) {
      setPos({ left: nextLeft, top: nextTop });
    }
    // Intentionally only run once per (x, y) change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [x, y, items.length]);

  // If a tall menu still doesn't fit, cap height and let it scroll.
  const maxH = window.innerHeight - 8;

  return createPortal(
    <>
      <div className="ctx-overlay" onMouseDown={onClose} />
      <div
        ref={menuRef}
        className="ctx-menu"
        role="menu"
        style={{
          left: pos.left,
          top: pos.top,
          maxHeight: maxH,
          overflowY: "auto",
        }}
      >
        {items.map((it, i) =>
          it === "separator" ? (
            <div key={i} className="ctx-sep" role="separator" />
          ) : (
            <button
              key={i}
              data-ctx-idx={i}
              role="menuitem"
              className={`ctx-item ${it.danger ? "danger" : ""}`}
              disabled={it.disabled}
              onClick={async () => {
                onClose();
                try {
                  await it.onClick();
                } catch (e) {
                  console.error("context menu action failed", e);
                }
              }}
            >
              {it.label}
            </button>
          ),
        )}
      </div>
    </>,
    document.body,
  );
}
