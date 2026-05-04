import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  setEditorSettings,
  useEditorSettings,
} from "../editorSettings";
import { useTheme, type ThemeMode } from "../theme";
import { onSettingsOpen } from "../settingsBus";
import { useStore } from "../store";
import { PROVIDERS, getApiKey, setApiKey } from "../providers";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  getToolPolicy,
  setToolPolicy,
  type ToolPermission,
  type ToolPolicy,
} from "../toolPermissions";
import { McpServerBrowser } from "./McpServerBrowser";
import { invoke } from "@tauri-apps/api/core";

export function SettingsModal() {
  const [open, setOpen] = useState(false);
  const settings = useEditorSettings();
  const [theme, setTheme] = useTheme();
  const activeId = useStore((s) => s.activeId);
  const sidebarSide = useStore((s) =>
    s.activeId ? s.loaded[s.activeId]?.layout.sidebarSide : "left",
  );
  const setSidebarSide = useStore((s) => s.setSidebarSide);

  useEffect(() => {
    return onSettingsOpen(() => setOpen(true));
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div className="settings-backdrop" onMouseDown={() => setOpen(false)}>
      <div
        className="settings-modal"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="settings-header">
          <span>Settings</span>
          <button
            className="settings-close"
            onClick={() => setOpen(false)}
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        <div className="settings-body">
          <Section title="Appearance">
            <Row label="Theme">
              <div className="settings-segmented">
                {(["light", "dark", "system"] as ThemeMode[]).map((m) => (
                  <button
                    key={m}
                    className={`segmented-btn ${theme === m ? "active" : ""}`}
                    onClick={() => setTheme(m)}
                  >
                    {m === "light" ? "☀ Light" : m === "dark" ? "🌙 Dark" : "⚙ System"}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="Sidebar position">
              <div className="settings-segmented">
                {(["left", "right"] as const).map((s) => (
                  <button
                    key={s}
                    className={`segmented-btn ${sidebarSide === s ? "active" : ""}`}
                    disabled={!activeId}
                    onClick={() => activeId && setSidebarSide(activeId, s)}
                  >
                    {s === "left" ? "← Left" : "Right →"}
                  </button>
                ))}
              </div>
            </Row>
          </Section>

          <Section title="Editor">
            <Row label="Font size">
              <input
                type="number"
                min={8}
                max={32}
                value={settings.fontSize}
                onChange={(e) =>
                  setEditorSettings({
                    fontSize: Math.max(
                      8,
                      Math.min(32, Number(e.target.value) || 13),
                    ),
                  })
                }
                className="settings-num"
              />
            </Row>
            <Row label="Tab size">
              <input
                type="number"
                min={1}
                max={8}
                value={settings.tabSize}
                onChange={(e) =>
                  setEditorSettings({
                    tabSize: Math.max(
                      1,
                      Math.min(8, Number(e.target.value) || 2),
                    ),
                  })
                }
                className="settings-num"
              />
            </Row>
            <Toggle
              label="Word wrap"
              value={settings.wordWrap === "on"}
              onChange={(v) =>
                setEditorSettings({ wordWrap: v ? "on" : "off" })
              }
            />
            <Toggle
              label="Show minimap"
              value={settings.minimap}
              onChange={(v) => setEditorSettings({ minimap: v })}
            />
          </Section>

          <Section title="On save">
            <Toggle
              label="Trim trailing whitespace"
              value={settings.trimTrailingWhitespace}
              onChange={(v) =>
                setEditorSettings({ trimTrailingWhitespace: v })
              }
            />
            <Toggle
              label="Insert final newline"
              value={settings.insertFinalNewline}
              onChange={(v) => setEditorSettings({ insertFinalNewline: v })}
            />
          </Section>

          <Section title="AI Tool Permissions">
            <ToolPermissionRow
              label="Read tools (list_files, read_file, search_text, read_terminal)"
              hint="Look at code and terminal output"
              field="read"
            />
            <ToolPermissionRow
              label="Web search"
              hint="Public DuckDuckGo search"
              field="webSearch"
            />
            <ToolPermissionRow
              label="Write tools (edit_file, create_file)"
              hint="Modify your code (always shows a diff before applying)"
              field="write"
            />
            <div className="settings-row settings-row-note">
              "Allow" runs the tool with no extra prompt. "Ask" pops a confirm
              dialog each time. "Deny" disables the tool — the AI sees a
              denial message instead of executing.
            </div>
          </Section>

          <Section title="Claude Code — Spend budget">
            <ClaudeCodeBudgetEditor />
          </Section>

          <Section title="Claude Code — Always-allow tools">
            <ClaudeCodeAlwaysAllowEditor />
          </Section>

          <Section title="Claude Code — MCP servers">
            <McpServerBrowser />
          </Section>

          <Section title="SFTP — Remote connections">
            <SftpProfilesEditor />
          </Section>

          <Section title="AI Providers (Bring Your Own Key)">
            {PROVIDERS.filter((p) => p.needsApiKey).map((p) => (
              <ApiKeyRow
                key={p.id}
                providerId={p.id}
                displayName={p.displayName}
                helpUrl={p.keyHelpUrl}
              />
            ))}
            <div className="settings-row settings-row-note">
              Keys are stored in <code>localStorage</code> on this machine and sent
              directly from the app to the provider. Ollama runs locally and needs
              no key.
            </div>
          </Section>

          <Section title="Auto-save">
            <Toggle
              label="Auto-save dirty files"
              value={settings.autoSave}
              onChange={(v) => setEditorSettings({ autoSave: v })}
            />
            <Row label="Auto-save delay (ms)">
              <input
                type="number"
                min={100}
                max={10000}
                step={100}
                value={settings.autoSaveDelayMs}
                onChange={(e) =>
                  setEditorSettings({
                    autoSaveDelayMs: Math.max(
                      100,
                      Math.min(10000, Number(e.target.value) || 1000),
                    ),
                  })
                }
                className="settings-num"
                disabled={!settings.autoSave}
              />
            </Row>
          </Section>
        </div>
        <div className="settings-foot">
          <span>
            Settings persist in <code>localStorage</code> · all changes
            apply immediately
          </span>
          <button onClick={() => setOpen(false)}>Done</button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-section">
      <div className="settings-section-title">{title}</div>
      <div className="settings-section-body">{children}</div>
    </div>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="settings-row">
      <span className="settings-row-label">{label}</span>
      {children}
    </div>
  );
}

function ToolPermissionRow({
  label,
  hint,
  field,
}: {
  label: string;
  hint: string;
  field: keyof ToolPolicy;
}) {
  const [policy, setPolicy] = useState<ToolPolicy>(() => getToolPolicy());
  const setValue = (v: ToolPermission) => {
    const next = { ...policy, [field]: v };
    setPolicy(next);
    setToolPolicy(next);
  };
  const cur = policy[field];
  return (
    <div className="settings-row settings-row-multiline">
      <div className="settings-row-stack">
        <span className="settings-row-label">{label}</span>
        <span className="settings-row-sub">{hint}</span>
      </div>
      <div className="settings-segmented">
        {(["allow", "ask", "deny"] as ToolPermission[]).map((v) => (
          <button
            key={v}
            className={`segmented-btn ${cur === v ? "active" : ""}`}
            onClick={() => setValue(v)}
          >
            {v === "allow" ? "Allow" : v === "ask" ? "Ask" : "Deny"}
          </button>
        ))}
      </div>
    </div>
  );
}

function ApiKeyRow({
  providerId,
  displayName,
  helpUrl,
}: {
  providerId: import("../providers").ProviderId;
  displayName: string;
  helpUrl?: string;
}) {
  const [value, setValue] = useState(() => getApiKey(providerId));
  const [revealed, setRevealed] = useState(false);
  const masked = value
    ? value.length <= 8
      ? "•".repeat(value.length)
      : value.slice(0, 4) + "•".repeat(Math.max(4, value.length - 8)) + value.slice(-4)
    : "";
  return (
    <div className="settings-row">
      <span className="settings-row-label">{displayName} API key</span>
      <div className="settings-key-cell">
        <input
          type={revealed ? "text" : "password"}
          value={revealed ? value : value || ""}
          placeholder={value && !revealed ? masked : "(not set)"}
          onChange={(e) => {
            setValue(e.target.value);
            setApiKey(providerId, e.target.value);
          }}
          className="settings-key-input"
          autoComplete="off"
          spellCheck={false}
        />
        <button
          className="settings-key-toggle"
          onClick={() => setRevealed((v) => !v)}
          title={revealed ? "Hide" : "Reveal"}
        >
          {revealed ? "🙈" : "👁"}
        </button>
        {helpUrl && (
          <button
            className="settings-key-help"
            onClick={() => void openUrl(helpUrl)}
            title="Get an API key"
          >
            Get key
          </button>
        )}
      </div>
    </div>
  );
}

function Toggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="settings-row">
      <span className="settings-row-label">{label}</span>
      <button
        className={`settings-toggle ${value ? "on" : ""}`}
        onClick={() => onChange(!value)}
        role="switch"
        aria-checked={value}
      >
        <span className="settings-toggle-knob" />
      </button>
    </div>
  );
}

const CC_ALWAYS_ALLOW_KEY = "lcp.claudeCode.alwaysAllow";
const CC_BUDGET_KEY = "lcp.claudeCode.budgetUsd";

function ClaudeCodeBudgetEditor() {
  const [val, setVal] = useState<string>(() => {
    try {
      const raw = localStorage.getItem(CC_BUDGET_KEY);
      const n = raw ? parseFloat(raw) : 0;
      return Number.isFinite(n) && n > 0 ? n.toString() : "";
    } catch {
      return "";
    }
  });

  const persist = (next: string) => {
    setVal(next);
    const n = parseFloat(next);
    try {
      if (Number.isFinite(n) && n > 0) {
        localStorage.setItem(CC_BUDGET_KEY, n.toString());
      } else {
        localStorage.removeItem(CC_BUDGET_KEY);
      }
    } catch {
      /* ignore */
    }
  };

  return (
    <>
      <Row label="Per-chat warning at">
        <div className="cc-budget-input">
          <span className="cc-budget-prefix">$</span>
          <input
            type="number"
            min="0"
            step="0.10"
            placeholder="0  (disabled)"
            value={val}
            onChange={(e) => persist(e.target.value)}
            className="cc-budget-field"
          />
          <span className="cc-budget-suffix">USD</span>
        </div>
      </Row>
      <div className="settings-row settings-row-note">
        Once a Claude Code chat's cumulative cost crosses this number, a
        warning toast fires (once per chat). Useful for catching the
        documented resume-cache-miss class of regressions where a
        normally-cheap chat suddenly burns 20× more than expected.
        Leave blank to disable. Subscription users (Pro / Max) can
        ignore — Anthropic doesn't bill via usd_cost.
      </div>
    </>
  );
}

function ClaudeCodeAlwaysAllowEditor() {
  const [list, setList] = useState<string[]>(() => loadList());

  function loadList(): string[] {
    try {
      const raw = localStorage.getItem(CC_ALWAYS_ALLOW_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((s) => typeof s === "string").sort()
        : [];
    } catch {
      return [];
    }
  }

  function persist(next: string[]) {
    setList(next);
    try {
      localStorage.setItem(CC_ALWAYS_ALLOW_KEY, JSON.stringify(next));
    } catch {
      /* ignore */
    }
  }

  // Split entries into the three kinds the permission overlay supports:
  //   - bare tool names (e.g. "Read", "Edit")
  //   - "Bash:<prefix>" — auto-allow Bash commands starting with prefix
  //   - "Ext:<.ext>:<tool>" — auto-allow path-tool calls on this filetype
  const tools: string[] = [];
  const bashPrefixes: string[] = [];
  const exts: { ext: string; tool: string; raw: string }[] = [];
  for (const v of list) {
    if (v.startsWith("Bash:")) bashPrefixes.push(v.slice(5));
    else if (v.startsWith("Ext:")) {
      const rest = v.slice(4);
      const colon = rest.indexOf(":");
      if (colon > 0) {
        exts.push({ ext: rest.slice(0, colon), tool: rest.slice(colon + 1), raw: v });
      }
    } else tools.push(v);
  }

  const removeEntry = (entry: string) =>
    persist(list.filter((n) => n !== entry));

  if (list.length === 0) {
    return (
      <div className="settings-row settings-row-note">
        No always-allow rules yet. The next time Claude Code asks for
        permission, click <strong>“Always allow {"{tool}"}”</strong> or
        <strong> “Always allow {"<prefix>"}”</strong> on the card to add
        an entry here. <em>“Allow this session”</em> on the card adds a
        temporary in-memory rule that doesn't appear here — it resets
        when you restart Codetta.
      </div>
    );
  }

  return (
    <>
      <div className="settings-row settings-row-note">
        Auto-approves matching requests without showing the permission card.
      </div>

      {tools.length > 0 && (
        <>
          <div className="cc-allow-subhead">Tools (any call)</div>
          <div className="cc-allow-list">
            {tools.map((name) => (
              <div key={`t:${name}`} className="cc-allow-row">
                <code className="cc-allow-name">{name}</code>
                <button
                  className="cc-allow-remove"
                  onClick={() => removeEntry(name)}
                  title={`Stop always-allowing ${name}`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {bashPrefixes.length > 0 && (
        <>
          <div className="cc-allow-subhead">
            Bash command prefixes (auto-allow when the command starts with…)
          </div>
          <div className="cc-allow-list">
            {bashPrefixes.map((p) => (
              <div key={`b:${p}`} className="cc-allow-row">
                <code className="cc-allow-name">{p} …</code>
                <button
                  className="cc-allow-remove"
                  onClick={() => removeEntry(`Bash:${p}`)}
                  title={`Stop always-allowing Bash commands starting with "${p}"`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {exts.length > 0 && (
        <>
          <div className="cc-allow-subhead">
            File extensions (auto-allow a tool on a specific filetype)
          </div>
          <div className="cc-allow-list">
            {exts.map((e) => (
              <div key={e.raw} className="cc-allow-row">
                <code className="cc-allow-name">
                  {e.tool} on {e.ext}
                </code>
                <button
                  className="cc-allow-remove"
                  onClick={() => removeEntry(e.raw)}
                  title={`Stop always-allowing ${e.tool} on ${e.ext} files`}
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="settings-row">
        <button
          className="cc-allow-clear"
          onClick={() => {
            if (
              confirm(
                "Clear all always-allow entries? Claude Code will ask for permission on every tool call again until you re-add them.",
              )
            ) {
              persist([]);
            }
          }}
        >
          Clear all
        </button>
      </div>
    </>
  );
}

// SFTP profiles — stored in localStorage as a JSON array. Each profile
// holds the connection details + a friendly label. Passwords sit
// alongside the existing API-key trust model: the user's localStorage
// is treated as a local secret store. Same caveat applies (anyone with
// disk access can read them).
const SFTP_PROFILES_KEY = "lcp.sftp.profiles";

interface SftpProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  /** Optional remote folder to land in on connect. Mirror of the field
   *  in the panel-side schema; both editors round-trip it untouched. */
  defaultPath?: string;
}

function loadSftpProfiles(): SftpProfile[] {
  try {
    const raw = localStorage.getItem(SFTP_PROFILES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (p): p is SftpProfile =>
        p &&
        typeof p.id === "string" &&
        typeof p.name === "string" &&
        typeof p.host === "string" &&
        typeof p.user === "string" &&
        typeof p.password === "string" &&
        typeof p.port === "number",
    );
  } catch {
    return [];
  }
}

function saveSftpProfiles(profiles: SftpProfile[]) {
  try {
    localStorage.setItem(SFTP_PROFILES_KEY, JSON.stringify(profiles));
  } catch {
    /* ignore */
  }
}

function emptyProfile(): SftpProfile {
  return {
    id: "p_" + Math.random().toString(36).slice(2, 10),
    name: "",
    host: "",
    port: 22,
    user: "",
    password: "",
  };
}

function SftpProfilesEditor() {
  const [profiles, setProfiles] = useState<SftpProfile[]>(() =>
    loadSftpProfiles(),
  );
  const [editing, setEditing] = useState<SftpProfile | null>(null);
  const [testState, setTestState] = useState<{
    profileId: string | "draft";
    status: "idle" | "testing" | "ok" | "fail";
    msg?: string;
  } | null>(null);

  const persist = (next: SftpProfile[]) => {
    setProfiles(next);
    saveSftpProfiles(next);
  };

  const startNew = () => {
    setEditing(emptyProfile());
    setTestState(null);
  };

  const startEdit = (p: SftpProfile) => {
    setEditing({ ...p });
    setTestState(null);
  };

  const cancelEdit = () => {
    setEditing(null);
    setTestState(null);
  };

  const saveEdit = () => {
    if (!editing) return;
    const trimmed: SftpProfile = {
      ...editing,
      name: editing.name.trim() || `${editing.user}@${editing.host}`,
      host: editing.host.trim(),
      user: editing.user.trim(),
      port: Math.max(1, Math.min(65535, editing.port || 22)),
    };
    if (!trimmed.host || !trimmed.user) return;
    const idx = profiles.findIndex((p) => p.id === trimmed.id);
    const next = [...profiles];
    if (idx >= 0) next[idx] = trimmed;
    else next.push(trimmed);
    persist(next);
    setEditing(null);
    setTestState(null);
  };

  const removeProfile = (id: string) => {
    if (!confirm("Delete this connection profile?")) return;
    persist(profiles.filter((p) => p.id !== id));
  };

  const testConnection = async (p: SftpProfile, key: string | "draft") => {
    setTestState({ profileId: key, status: "testing" });
    try {
      const result = await invoke<{
        server_banner: string;
        home_dir: string;
        entry_count: number;
      }>("sftp_test_connection", {
        args: {
          host: p.host,
          port: p.port,
          user: p.user,
          password: p.password,
        },
      });
      setTestState({
        profileId: key,
        status: "ok",
        msg: `${result.server_banner} — home: ${result.home_dir} (${result.entry_count} entries)`,
      });
    } catch (e) {
      setTestState({
        profileId: key,
        status: "fail",
        msg: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <>
      <div className="settings-row settings-row-note">
        Saved SFTP/SSH connections. Test verifies credentials before
        saving. Used by the Remote browser (coming soon) and as a
        deploy target for upload/download from the file tree.
        Passwords are stored locally in <code>localStorage</code>.
      </div>

      {profiles.length === 0 && !editing && (
        <div className="settings-row settings-row-note">
          No connections yet. Click <strong>Add connection</strong> below.
        </div>
      )}

      {profiles.map((p) => (
        <div key={p.id} className="sftp-profile-row">
          <div className="sftp-profile-meta">
            <span className="sftp-profile-name">{p.name}</span>
            <span className="sftp-profile-detail">
              {p.user}@{p.host}:{p.port}
            </span>
          </div>
          <div className="sftp-profile-actions">
            <button
              className="sftp-btn"
              onClick={() => void testConnection(p, p.id)}
              disabled={testState?.profileId === p.id && testState.status === "testing"}
            >
              {testState?.profileId === p.id && testState.status === "testing"
                ? "Testing…"
                : "Test"}
            </button>
            <button className="sftp-btn" onClick={() => startEdit(p)}>
              Edit
            </button>
            <button
              className="sftp-btn sftp-btn-danger"
              onClick={() => removeProfile(p.id)}
            >
              Delete
            </button>
          </div>
          {testState?.profileId === p.id && testState.status !== "idle" && testState.status !== "testing" && (
            <div
              className={`sftp-profile-test sftp-profile-test-${testState.status}`}
            >
              {testState.status === "ok" ? "✓ " : "✗ "}
              {testState.msg}
            </div>
          )}
        </div>
      ))}

      {editing && (
        <div className="sftp-profile-edit">
          <Row label="Label">
            <input
              className="sftp-field"
              value={editing.name}
              placeholder="Production web server"
              onChange={(e) =>
                setEditing({ ...editing, name: e.target.value })
              }
            />
          </Row>
          <Row label="Host">
            <input
              className="sftp-field"
              value={editing.host}
              placeholder="example.com or 192.0.2.10"
              onChange={(e) =>
                setEditing({ ...editing, host: e.target.value })
              }
            />
          </Row>
          <Row label="Port">
            <input
              className="settings-num"
              type="number"
              min={1}
              max={65535}
              value={editing.port}
              onChange={(e) =>
                setEditing({ ...editing, port: Number(e.target.value) || 22 })
              }
            />
          </Row>
          <Row label="Username">
            <input
              className="sftp-field"
              value={editing.user}
              autoComplete="off"
              onChange={(e) =>
                setEditing({ ...editing, user: e.target.value })
              }
            />
          </Row>
          <Row label="Password">
            <input
              className="sftp-field"
              type="password"
              value={editing.password}
              autoComplete="new-password"
              onChange={(e) =>
                setEditing({ ...editing, password: e.target.value })
              }
            />
          </Row>
          <Row label="Default folder">
            <input
              className="sftp-field"
              value={editing.defaultPath ?? ""}
              placeholder="/var/www/site (optional — defaults to SSH home)"
              onChange={(e) =>
                setEditing({ ...editing, defaultPath: e.target.value })
              }
            />
          </Row>
          <div className="sftp-profile-edit-actions">
            <button
              className="sftp-btn"
              onClick={() => void testConnection(editing, "draft")}
              disabled={
                !editing.host ||
                !editing.user ||
                (testState?.profileId === "draft" && testState.status === "testing")
              }
            >
              {testState?.profileId === "draft" && testState.status === "testing"
                ? "Testing…"
                : "Test connection"}
            </button>
            <button
              className="sftp-btn sftp-btn-primary"
              onClick={saveEdit}
              disabled={!editing.host || !editing.user}
            >
              Save
            </button>
            <button className="sftp-btn" onClick={cancelEdit}>
              Cancel
            </button>
          </div>
          {testState?.profileId === "draft" && testState.status !== "idle" && testState.status !== "testing" && (
            <div
              className={`sftp-profile-test sftp-profile-test-${testState.status}`}
            >
              {testState.status === "ok" ? "✓ " : "✗ "}
              {testState.msg}
            </div>
          )}
        </div>
      )}

      {!editing && (
        <div className="settings-row">
          <button className="sftp-btn sftp-btn-primary" onClick={startNew}>
            + Add connection
          </button>
        </div>
      )}
    </>
  );
}
