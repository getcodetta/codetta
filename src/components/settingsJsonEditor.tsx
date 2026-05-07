// Power-user settings editor — render every known config key as JSON
// so the user can hand-edit, paste a backup, or wipe a single value.
// Pulled out of SettingsModal so its 1600-line file can shrink and so
// the editor's allowlist (SETTINGS_KEYS) lives next to the helpers
// that consume it.
//
// SETTINGS_KEYS is intentionally narrow: configuration only. Workspace
// state, chat history, AI session caches, etc. are app-internal and
// must NOT show up in this editor — they'd let a typo wipe the user's
// open tabs and conversation log.

import { useState } from "react";
import { confirm as dialogConfirm } from "../dialog";
import { errMsg } from "../notify";
import { confirmDiscardUnsaved } from "../actions";
import {
  getString as lsGetString,
  remove as lsRemove,
  setJson as lsSetJson,
  setString as lsSetString,
} from "../localStore";

export const SETTINGS_KEYS = [
  "lcp.theme",
  "lcp.editor.settings",
  "lcp.toolPolicy",
  "lcp.claudeCode.alwaysAllow",
  "lcp.claudeCode.budgetUsd",
  "lcp.sftp.profiles",
  "lcp.ai.privacy.exclusions",
  "lcp.ai.usage.hardCapUsd",
  "lcp.ollama.lastModel",
  "lcp.providers.openai.apiKey",
  "lcp.providers.anthropic.apiKey",
] as const;

/**
 * Serialise every known settings key out of localStorage as a pretty
 * JSON object. Values are JSON-parsed when possible; raw strings
 * otherwise so the editor doesn't choke on legacy values.
 */
function snapshotSettingsJson(): string {
  const out: Record<string, unknown> = {};
  for (const k of SETTINGS_KEYS) {
    const raw = lsGetString(k);
    if (raw == null) continue;
    try {
      out[k] = JSON.parse(raw);
    } catch {
      out[k] = raw;
    }
  }
  return JSON.stringify(out, null, 2);
}

export function SettingsJsonEditor({ onClose }: { onClose: () => void }) {
  const [text, setText] = useState<string>(() => snapshotSettingsJson());
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "ok"; count: number }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const reload = () => {
    setText(snapshotSettingsJson());
    setStatus({ kind: "idle" });
  };

  const apply = async () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setStatus({
        kind: "error",
        message: `Invalid JSON: ${errMsg(e)}`,
      });
      return;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      setStatus({
        kind: "error",
        message: "Top-level value must be a JSON object.",
      });
      return;
    }
    const next = parsed as Record<string, unknown>;
    // Confirm before applying — JSON edits can wipe credentials. Was
    // using the native browser confirm() which has a different look,
    // can't be styled, and is increasingly throttled in webviews.
    const removed = SETTINGS_KEYS.filter(
      (k) => lsGetString(k) != null && !(k in next),
    );
    if (removed.length > 0) {
      const ok = await dialogConfirm(
        `These settings will be DELETED:\n\n  ${removed.join("\n  ")}\n\nApply anyway?`,
        {
          title: "Delete settings",
          okLabel: "Apply",
          cancelLabel: "Cancel",
          danger: true,
        },
      );
      if (!ok) return;
    }
    let count = 0;
    for (const k of SETTINGS_KEYS) {
      if (k in next) {
        const v = next[k];
        const ok =
          typeof v === "string" ? lsSetString(k, v) : lsSetJson(k, v);
        if (ok) count++;
      } else if (lsGetString(k) != null) {
        lsRemove(k);
      }
    }
    setStatus({ kind: "ok", count });
    // Offer to reload so every component picks up the new values.
    // Routes through confirmDiscardUnsaved so any open buffer edits
    // get the same "are you sure?" prompt as Ctrl+R.
    const wantsReload = await dialogConfirm(
      "Settings applied. Reload the editor to make sure every component picks up the new values?",
      {
        title: "Reload?",
        okLabel: "Reload",
        cancelLabel: "Not now",
      },
    );
    if (wantsReload && (await confirmDiscardUnsaved("Reload"))) {
      window.location.reload();
    }
  };

  return (
    <div className="settings-json-pane">
      <div className="settings-json-toolbar">
        <button className="sftp-btn" onClick={reload}>
          Reload from disk
        </button>
        <button
          className="sftp-btn"
          onClick={() => {
            void navigator.clipboard.writeText(text);
            setStatus({
              kind: "ok",
              count: 0,
            });
          }}
        >
          Copy
        </button>
        <span className="settings-json-spacer"></span>
        <button
          className="sftp-btn sftp-btn-primary"
          onClick={() => void apply()}
        >
          Apply changes
        </button>
        <button className="sftp-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      {status.kind === "error" && (
        <div className="settings-json-status settings-json-status-error">
          {status.message}
        </div>
      )}
      {status.kind === "ok" && (
        <div className="settings-json-status settings-json-status-ok">
          {status.count > 0
            ? `Applied ${status.count} settings.`
            : "Copied to clipboard."}
        </div>
      )}
      <textarea
        className="settings-json-textarea"
        value={text}
        spellCheck={false}
        onChange={(e) => {
          setText(e.target.value);
          setStatus({ kind: "idle" });
        }}
      />
      <div className="settings-row settings-row-note">
        Each top-level key maps directly to a <code>localStorage</code>{" "}
        entry. Values are stored as JSON or plain strings (whichever the
        feature owns). Invalid JSON is rejected before any write. Removing
        a key from the JSON deletes it from <code>localStorage</code>.
        Only configuration keys are shown — chat history, workspace
        state, and other internal data are not touched.
      </div>
    </div>
  );
}
