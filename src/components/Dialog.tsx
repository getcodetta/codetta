import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { resolveDialog, useDialog } from "../dialog";

export function Dialog() {
  const req = useDialog();
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!req) return;
    setText(req.defaultValue ?? "");
    if (req.kind === "prompt") {
      requestAnimationFrame(() => {
        inputRef.current?.focus();
        inputRef.current?.select();
      });
    }
  }, [req]);

  useEffect(() => {
    if (!req) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (req.kind === "alert") resolveDialog(null);
        else resolveDialog(false);
      } else if (e.key === "Enter" && req.kind !== "prompt") {
        e.preventDefault();
        resolveDialog(req.kind === "confirm" ? true : null);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [req]);

  if (!req) return null;

  const okLabel = req.okLabel ?? "OK";
  const cancelLabel = req.cancelLabel ?? "Cancel";
  const title =
    req.title ??
    (req.kind === "alert"
      ? "Notice"
      : req.kind === "confirm"
        ? "Confirm"
        : "Input");

  const submit = () => {
    if (req.kind === "alert") resolveDialog(null);
    else if (req.kind === "confirm") resolveDialog(true);
    else resolveDialog(text);
  };
  const cancel = () => {
    if (req.kind === "alert") resolveDialog(null);
    else if (req.kind === "confirm") resolveDialog(false);
    else resolveDialog(null);
  };

  return createPortal(
    <div className="dialog-backdrop" onMouseDown={cancel}>
      <div
        className="dialog-card"
        role={req.kind === "alert" ? "alertdialog" : "dialog"}
        aria-modal="true"
        aria-labelledby="dialog-title"
        aria-describedby="dialog-body"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="dialog-title" id="dialog-title">{title}</div>
        <div className="dialog-body" id="dialog-body">{req.message}</div>
        {req.kind === "prompt" && (
          <input
            ref={inputRef}
            className="dialog-input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submit();
              }
            }}
          />
        )}
        <div className="dialog-actions">
          {req.kind !== "alert" && (
            <button onClick={cancel}>{cancelLabel}</button>
          )}
          <button
            className={`primary ${req.danger ? "danger" : ""}`}
            onClick={submit}
            autoFocus={req.kind !== "prompt"}
          >
            {okLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
