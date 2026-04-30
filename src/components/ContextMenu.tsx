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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

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
        style={{
          left: pos.left,
          top: pos.top,
          maxHeight: maxH,
          overflowY: "auto",
        }}
      >
        {items.map((it, i) =>
          it === "separator" ? (
            <div key={i} className="ctx-sep" />
          ) : (
            <button
              key={i}
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
