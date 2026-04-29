import { useEffect } from "react";
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
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Clamp into viewport.
  const maxX = window.innerWidth - 220;
  const maxY = window.innerHeight - 8;
  const left = Math.max(4, Math.min(x, maxX));
  const top = Math.max(4, Math.min(y, maxY));

  return createPortal(
    <>
      <div className="ctx-overlay" onMouseDown={onClose} />
      <div className="ctx-menu" style={{ left, top }}>
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
