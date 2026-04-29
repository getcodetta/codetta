import { createPortal } from "react-dom";
import { useDrag } from "../dragState";

export function DragGhost() {
  const drag = useDrag();
  if (!drag) return null;
  return createPortal(
    <div
      className="drag-ghost"
      style={{ left: drag.x + 14, top: drag.y + 14 }}
    >
      {drag.label}
    </div>,
    document.body,
  );
}
