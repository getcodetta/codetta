// Per-machine "footprint" preferences for keeping long-running editor
// sessions cheap. Mirrors the shape of editorSettings.ts so the two
// modules look familiar side-by-side, but they're intentionally
// independent: a user might want aggressive auto-save without
// aggressive memory drops, or vice versa.
//
// Two trade-offs are encoded here:
//   1. idleBufferUnload — drop a file's contents from the in-memory
//      store after N minutes of no editor focus / cursor activity.
//      The tab key stays in the layout so the user can click it; the
//      next click triggers a fresh disk read via the existing openFile
//      path. Acceptable cost for the memory we get back.
//   2. idleTerminalClose — close terminals that haven't seen input or
//      focus in N minutes. Saves a long-lived PTY per stale tab.
//
// Both default to false so an upgrade doesn't surprise anyone with
// disappearing buffers or shells.

import { useEffect, useState } from "react";
import { getJson, setJson } from "./localStore";

export interface FootprintSettings {
  idleBufferUnloadEnabled: boolean;
  idleBufferUnloadMinutes: number;
  idleTerminalCloseEnabled: boolean;
  idleTerminalCloseMinutes: number;
}

const STORAGE_KEY = "lcp.footprintSettings";
const DEFAULT: FootprintSettings = {
  idleBufferUnloadEnabled: false,
  idleBufferUnloadMinutes: 30,
  idleTerminalCloseEnabled: false,
  idleTerminalCloseMinutes: 60,
};

export const IDLE_BUFFER_MIN = 5;
export const IDLE_BUFFER_MAX = 240;
export const IDLE_TERMINAL_MIN = 10;
export const IDLE_TERMINAL_MAX = 480;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function read(): FootprintSettings {
  const raw = getJson<Record<string, unknown>>(
    STORAGE_KEY,
    {},
    (p): p is Record<string, unknown> => !!p && typeof p === "object",
  );
  return {
    idleBufferUnloadEnabled:
      typeof raw.idleBufferUnloadEnabled === "boolean"
        ? raw.idleBufferUnloadEnabled
        : DEFAULT.idleBufferUnloadEnabled,
    idleBufferUnloadMinutes:
      typeof raw.idleBufferUnloadMinutes === "number" &&
      Number.isFinite(raw.idleBufferUnloadMinutes)
        ? clamp(
            Math.round(raw.idleBufferUnloadMinutes),
            IDLE_BUFFER_MIN,
            IDLE_BUFFER_MAX,
          )
        : DEFAULT.idleBufferUnloadMinutes,
    idleTerminalCloseEnabled:
      typeof raw.idleTerminalCloseEnabled === "boolean"
        ? raw.idleTerminalCloseEnabled
        : DEFAULT.idleTerminalCloseEnabled,
    idleTerminalCloseMinutes:
      typeof raw.idleTerminalCloseMinutes === "number" &&
      Number.isFinite(raw.idleTerminalCloseMinutes)
        ? clamp(
            Math.round(raw.idleTerminalCloseMinutes),
            IDLE_TERMINAL_MIN,
            IDLE_TERMINAL_MAX,
          )
        : DEFAULT.idleTerminalCloseMinutes,
  };
}

let _settings: FootprintSettings = read();
const listeners = new Set<(s: FootprintSettings) => void>();

function persist() {
  setJson(STORAGE_KEY, _settings);
}

export function getFootprintSettings(): FootprintSettings {
  return _settings;
}

export function setFootprintSettings(patch: Partial<FootprintSettings>) {
  const merged = { ..._settings, ...patch };
  // Re-clamp on every write so a bad value sneaking in via the JSON
  // editor (or a future code path) can't poison the in-memory cache.
  _settings = {
    idleBufferUnloadEnabled: !!merged.idleBufferUnloadEnabled,
    idleBufferUnloadMinutes: clamp(
      Math.round(
        Number.isFinite(merged.idleBufferUnloadMinutes)
          ? merged.idleBufferUnloadMinutes
          : DEFAULT.idleBufferUnloadMinutes,
      ),
      IDLE_BUFFER_MIN,
      IDLE_BUFFER_MAX,
    ),
    idleTerminalCloseEnabled: !!merged.idleTerminalCloseEnabled,
    idleTerminalCloseMinutes: clamp(
      Math.round(
        Number.isFinite(merged.idleTerminalCloseMinutes)
          ? merged.idleTerminalCloseMinutes
          : DEFAULT.idleTerminalCloseMinutes,
      ),
      IDLE_TERMINAL_MIN,
      IDLE_TERMINAL_MAX,
    ),
  };
  persist();
  for (const l of listeners) l(_settings);
}

export function useFootprintSettings(): FootprintSettings {
  const [s, setS] = useState(_settings);
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}
