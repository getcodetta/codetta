import { useEffect, useState } from "react";

export type DialogKind = "alert" | "confirm" | "prompt";

export interface DialogRequest {
  id: number;
  kind: DialogKind;
  title?: string;
  message: string;
  defaultValue?: string;
  okLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  resolve: (value: boolean | string | null) => void;
}

let nextId = 1;
let current: DialogRequest | null = null;
const queue: DialogRequest[] = [];
const listeners = new Set<(d: DialogRequest | null) => void>();

function notify() {
  for (const l of listeners) l(current);
}

function pump(req: DialogRequest) {
  if (current) {
    queue.push(req);
  } else {
    current = req;
    notify();
  }
}

export function alert(
  message: string,
  opts?: { title?: string; okLabel?: string },
): Promise<void> {
  return new Promise((resolve) => {
    pump({
      id: nextId++,
      kind: "alert",
      message,
      title: opts?.title,
      okLabel: opts?.okLabel,
      resolve: () => resolve(),
    });
  });
}

export function confirm(
  message: string,
  opts?: {
    title?: string;
    okLabel?: string;
    cancelLabel?: string;
    danger?: boolean;
  },
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    pump({
      id: nextId++,
      kind: "confirm",
      message,
      title: opts?.title,
      okLabel: opts?.okLabel,
      cancelLabel: opts?.cancelLabel,
      danger: opts?.danger,
      resolve: (v) => resolve(v === true),
    });
  });
}

export function prompt(
  message: string,
  defaultValue = "",
  opts?: { title?: string; okLabel?: string; cancelLabel?: string },
): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    pump({
      id: nextId++,
      kind: "prompt",
      message,
      defaultValue,
      title: opts?.title,
      okLabel: opts?.okLabel,
      cancelLabel: opts?.cancelLabel,
      resolve: (v) => resolve(typeof v === "string" ? v : null),
    });
  });
}

export function resolveDialog(value: boolean | string | null) {
  if (!current) return;
  const c = current;
  current = queue.shift() ?? null;
  notify();
  c.resolve(value);
}

export function useDialog(): DialogRequest | null {
  const [d, setD] = useState(current);
  useEffect(() => {
    listeners.add(setD);
    return () => {
      listeners.delete(setD);
    };
  }, []);
  return d;
}
