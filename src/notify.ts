import { useEffect, useState } from "react";

export type ToastKind = "info" | "success" | "warning" | "error";

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  timeoutMs: number;
}

let _toasts: Toast[] = [];
let _nextId = 1;
const listeners = new Set<(t: Toast[]) => void>();

function notifyListeners() {
  for (const l of listeners) l(_toasts);
}

function defaultTimeout(kind: ToastKind): number {
  switch (kind) {
    case "warning":
      return 6000;
    case "error":
      return 8000;
    case "info":
    case "success":
    default:
      return 4000;
  }
}

export function notify(
  message: string,
  kind: ToastKind = "info",
  timeoutMs?: number,
): void {
  const id = _nextId++;
  const finalTimeout = timeoutMs ?? defaultTimeout(kind);
  const toast: Toast = { id, kind, message, timeoutMs: finalTimeout };
  _toasts = [..._toasts, toast];
  notifyListeners();
  if (finalTimeout > 0) {
    setTimeout(() => dismissToast(id), finalTimeout);
  }
}

export function info(message: string): void {
  notify(message, "info");
}

export function success(message: string): void {
  notify(message, "success");
}

export function warning(message: string): void {
  notify(message, "warning");
}

export function error(message: string): void {
  notify(message, "error");
}

export function dismissToast(id: number): void {
  const next = _toasts.filter((t) => t.id !== id);
  if (next.length === _toasts.length) return;
  _toasts = next;
  notifyListeners();
}

export function useToasts(): Toast[] {
  const [t, setT] = useState<Toast[]>(_toasts);
  useEffect(() => {
    listeners.add(setT);
    return () => {
      listeners.delete(setT);
    };
  }, []);
  return t;
}
