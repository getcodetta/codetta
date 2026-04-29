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
