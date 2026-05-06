import { createPortal } from "react-dom";
import {
  dismissToast,
  pauseToast,
  resumeToast,
  useToasts,
  type Toast,
} from "../notify";

export function Toasts() {
  const toasts = useToasts();
  if (toasts.length === 0) return null;
  return createPortal(
    <div className="toast-stack">
      {toasts.map((t: Toast) => (
        <div
          key={t.id}
          className={`toast toast-${t.kind}`}
          onMouseEnter={() => pauseToast(t.id)}
          onMouseLeave={() => resumeToast(t.id)}
        >
          <span className="toast-message">{t.message}</span>
          <button
            className="toast-close"
            onClick={() => dismissToast(t.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
