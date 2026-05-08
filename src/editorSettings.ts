import { useEffect, useState } from "react";
import { info as toastInfo } from "./notify";
import { getJson, setJson } from "./localStore";

export interface EditorSettings {
  fontSize: number;
  wordWrap: "off" | "on";
  tabSize: number;
  autoSave: boolean;
  autoSaveDelayMs: number;
  minimap: boolean;
  trimTrailingWhitespace: boolean;
  insertFinalNewline: boolean;
  /** Run Monaco's "format document" action on Ctrl+S before writing
   *  to disk. Skipped on auto-save to avoid the editor jumping while
   *  the user is still typing. */
  formatOnSave: boolean;
  /** Vertical guides at the configured columns (e.g. [80, 100]).
   *  Empty array disables. */
  rulers: number[];
  /** Monaco's auto-pair-brackets behaviour. "languageDefined" preserves
   *  Monaco's default (pair where the language config says so);
   *  "always" pairs in every language; "never" disables auto-pairing
   *  entirely — useful for plain-prose / markdown editing where the
   *  closing bracket gets in the way. */
  autoClosingBrackets: "always" | "languageDefined" | "never";
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
  formatOnSave: false,
  rulers: [],
  autoClosingBrackets: "languageDefined",
};

function read(): EditorSettings {
  const raw = getJson<Record<string, unknown>>(
    STORAGE_KEY,
    {},
    (p): p is Record<string, unknown> => !!p && typeof p === "object",
  );
  return {
    fontSize:
      typeof raw.fontSize === "number" &&
      raw.fontSize >= 8 &&
      raw.fontSize <= 32
        ? raw.fontSize
        : DEFAULT.fontSize,
    wordWrap: raw.wordWrap === "on" ? "on" : "off",
    tabSize:
      typeof raw.tabSize === "number" &&
      raw.tabSize >= 1 &&
      raw.tabSize <= 8
        ? raw.tabSize
        : DEFAULT.tabSize,
    autoSave:
      typeof raw.autoSave === "boolean" ? raw.autoSave : DEFAULT.autoSave,
    autoSaveDelayMs:
      typeof raw.autoSaveDelayMs === "number" &&
      raw.autoSaveDelayMs >= 100 &&
      raw.autoSaveDelayMs <= 10000
        ? raw.autoSaveDelayMs
        : DEFAULT.autoSaveDelayMs,
    minimap:
      typeof raw.minimap === "boolean" ? raw.minimap : DEFAULT.minimap,
    trimTrailingWhitespace:
      typeof raw.trimTrailingWhitespace === "boolean"
        ? raw.trimTrailingWhitespace
        : DEFAULT.trimTrailingWhitespace,
    insertFinalNewline:
      typeof raw.insertFinalNewline === "boolean"
        ? raw.insertFinalNewline
        : DEFAULT.insertFinalNewline,
    formatOnSave:
      typeof raw.formatOnSave === "boolean"
        ? raw.formatOnSave
        : DEFAULT.formatOnSave,
    rulers: Array.isArray(raw.rulers)
      ? raw.rulers.filter(
          (n): n is number =>
            typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1000,
        )
      : DEFAULT.rulers,
    autoClosingBrackets:
      raw.autoClosingBrackets === "always" ||
      raw.autoClosingBrackets === "languageDefined" ||
      raw.autoClosingBrackets === "never"
        ? raw.autoClosingBrackets
        : DEFAULT.autoClosingBrackets,
  };
}

let _settings: EditorSettings = read();
const listeners = new Set<(s: EditorSettings) => void>();

function persist() {
  setJson(STORAGE_KEY, _settings);
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
// Toggles fire silently otherwise — Alt+Z (word wrap) and the various
// File-menu "Toggle" entries gave the user no feedback that anything
// changed. A short toast confirms the new state ("Word wrap: on") so
// the keystroke doesn't feel like it landed in a void.
export function toggleWordWrap() {
  const next = _settings.wordWrap === "on" ? "off" : "on";
  setEditorSettings({ wordWrap: next });
  toastInfo(`Word wrap: ${next}`);
}
export function toggleAutoSave() {
  const next = !_settings.autoSave;
  setEditorSettings({ autoSave: next });
  toastInfo(`Auto-save: ${next ? "on" : "off"}`);
}
export function toggleMinimap() {
  const next = !_settings.minimap;
  setEditorSettings({ minimap: next });
  toastInfo(`Minimap: ${next ? "on" : "off"}`);
}
export function toggleTrimTrailingWhitespace() {
  const next = !_settings.trimTrailingWhitespace;
  setEditorSettings({ trimTrailingWhitespace: next });
  toastInfo(`Trim trailing whitespace on save: ${next ? "on" : "off"}`);
}
export function toggleInsertFinalNewline() {
  const next = !_settings.insertFinalNewline;
  setEditorSettings({ insertFinalNewline: next });
  toastInfo(`Insert final newline on save: ${next ? "on" : "off"}`);
}
export function toggleFormatOnSave() {
  const next = !_settings.formatOnSave;
  setEditorSettings({ formatOnSave: next });
  toastInfo(`Format on save: ${next ? "on" : "off"}`);
}
export function setAutoClosingBrackets(
  v: EditorSettings["autoClosingBrackets"],
) {
  setEditorSettings({ autoClosingBrackets: v });
}
// Cycle order matches the segmented-control left-to-right reading order
// in the settings UI so users mashing the palette command can predict
// where they'll land next.
export function cycleAutoClosingBrackets() {
  const order: EditorSettings["autoClosingBrackets"][] = [
    "always",
    "languageDefined",
    "never",
  ];
  const idx = order.indexOf(_settings.autoClosingBrackets);
  const next = order[(idx + 1) % order.length];
  setEditorSettings({ autoClosingBrackets: next });
  toastInfo(`Auto-closing brackets: ${next}`);
}
