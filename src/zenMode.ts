// Global "zen mode" toggle — hides every panel, bar, and rail so the
// editor area stretches edge to edge for distraction-free coding.
//
// Why a global flag instead of per-workspace: the chrome (TopBar,
// ActivityBar, StatusBar) lives above the workspace layer and switches
// active workspace doesn't cross those boundaries. A workspace-level
// flag would force shouty branching in App.tsx ("which workspace's
// zen state am I respecting?") that helps no one. Zen is a viewing
// preference, not project state.
//
// Persistence: localStorage so the flag survives reloads — but we
// deliberately *don't* fire a toast on toggle. The chrome
// disappearing IS the feedback; an extra notification would be
// gilding the lily.

import { useEffect, useState } from "react";
import { getString as lsGetString, setString as lsSetString } from "./localStore";

const KEY = "lcp.zenMode";

let _zen = lsGetString(KEY) === "1";
const listeners = new Set<(v: boolean) => void>();

function notify() {
  for (const l of listeners) l(_zen);
}

export function getZenMode(): boolean {
  return _zen;
}

export function setZenMode(v: boolean): void {
  if (_zen === v) return;
  _zen = v;
  if (v) lsSetString(KEY, "1");
  else lsSetString(KEY, "");
  notify();
}

export function toggleZenMode(): void {
  setZenMode(!_zen);
}

export function useZenMode(): boolean {
  const [v, setV] = useState(_zen);
  useEffect(() => {
    listeners.add(setV);
    return () => {
      listeners.delete(setV);
    };
  }, []);
  return v;
}
