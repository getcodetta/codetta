import { useEffect, useState } from "react";

export interface EditorSettings {
  fontSize: number;
  wordWrap: "off" | "on";
  tabSize: number;
  autoSave: boolean;
  autoSaveDelayMs: number;
  minimap: boolean;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
}

const STORAGE_KEY = "lcp.editorSettings";
const DEFAULT: EditorSettings = {
  fontSize: 13,
  wordWrap: "off",
  tabSize: 2,
  autoSave: false,
  autoSaveDelayMs: 1000,
  minimap: false,
  trimTrailingWhitespace: false,
  insertFinalNewline: false,
};

function read(): EditorSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULT };
    const parsed = JSON.parse(raw);
    return {
      fontSize:
        typeof parsed.fontSize === "number" &&
        parsed.fontSize >= 8 &&
        parsed.fontSize <= 32
          ? parsed.fontSize
          : DEFAULT.fontSize,
      wordWrap: parsed.wordWrap === "on" ? "on" : "off",
      tabSize:
        typeof parsed.tabSize === "number" &&
        parsed.tabSize >= 1 &&
        parsed.tabSize <= 8
          ? parsed.tabSize
          : DEFAULT.tabSize,
      autoSave: typeof parsed.autoSave === "boolean" ? parsed.autoSave : DEFAULT.autoSave,
      autoSaveDelayMs:
        typeof parsed.autoSaveDelayMs === "number" &&
        parsed.autoSaveDelayMs >= 100 &&
        parsed.autoSaveDelayMs <= 10000
          ? parsed.autoSaveDelayMs
          : DEFAULT.autoSaveDelayMs,
      minimap:
        typeof parsed.minimap === "boolean" ? parsed.minimap : DEFAULT.minimap,
      trimTrailingWhitespace:
        typeof parsed.trimTrailingWhitespace === "boolean"
          ? parsed.trimTrailingWhitespace
          : DEFAULT.trimTrailingWhitespace,
      insertFinalNewline:
        typeof parsed.insertFinalNewline === "boolean"
          ? parsed.insertFinalNewline
          : DEFAULT.insertFinalNewline,
    };
  } catch {
    return { ...DEFAULT };
  }
}

let _settings: EditorSettings = read();
const listeners = new Set<(s: EditorSettings) => void>();

function persist() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(_settings));
  } catch {
    /* ignore */
  }
}

export function getEditorSettings(): EditorSettings {
  return _settings;
}

export function setEditorSettings(patch: Partial<EditorSettings>) {
  _settings = { ..._settings, ...patch };
  persist();
  for (const l of listeners) l(_settings);
}

export function useEditorSettings(): EditorSettings {
  const [s, setS] = useState(_settings);
  useEffect(() => {
    listeners.add(setS);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

export function zoomIn() {
  setEditorSettings({
    fontSize: Math.min(32, _settings.fontSize + 1),
  });
}
export function zoomOut() {
  setEditorSettings({
    fontSize: Math.max(8, _settings.fontSize - 1),
  });
}
export function zoomReset() {
  setEditorSettings({ fontSize: DEFAULT.fontSize });
}
export function toggleWordWrap() {
  setEditorSettings({
    wordWrap: _settings.wordWrap === "on" ? "off" : "on",
  });
}
export function toggleAutoSave() {
  setEditorSettings({ autoSave: !_settings.autoSave });
}
export function toggleMinimap() {
  setEditorSettings({ minimap: !_settings.minimap });
}
export function toggleTrimTrailingWhitespace() {
  setEditorSettings({
    trimTrailingWhitespace: !_settings.trimTrailingWhitespace,
  });
}
export function toggleInsertFinalNewline() {
  setEditorSettings({ insertFinalNewline: !_settings.insertFinalNewline });
}
