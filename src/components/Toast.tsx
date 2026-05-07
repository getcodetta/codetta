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
    // aria-live="polite" so screen readers announce new toasts as they
    // arrive without interrupting whatever the user is on. Errors and
    // warnings escalate to assertive — those are usually action-required
    // (auth failed, file save errored, etc.) so an interruption is
    // correct. role="status" on the container, role="alert" on the
    // assertive items mirror the same intent.
    <div className="toast-stack" aria-live="polite" role="status">
      {toasts.map((t: Toast) => {
        const isAssertive = t.kind === "error" || t.kind === "warning";
        return (
          <div
            key={t.id}
            className={`toast toast-${t.kind}`}
            role={isAssertive ? "alert" : undefined}
            aria-live={isAssertive ? "assertive" : undefined}
            onMouseEnter={() => pauseToast(t.id)}
            onMouseLeave={() => resumeToast(t.id)}
          >
            <span className="toast-message">{t.message}</span>
            {t.count > 1 && (
              <span
                className="toast-count"
                aria-label={`Repeated ${t.count} times`}
                title={`Repeated ${t.count} times`}
              >
                ×{t.count}
              </span>
            )}
            <button
              className="toast-close"
              onClick={() => dismissToast(t.id)}
              aria-label="Dismiss notification"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>,
    document.body,
  );
}
