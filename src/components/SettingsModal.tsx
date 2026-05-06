import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
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
import {
  DEFAULT_EXCLUSIONS,
  effectivePatterns,
  loadPrivacySettings,
  matchExclusion,
  savePrivacySettings,
} from "../aiPrivacy";
import {
  clearUsage,
  loadHardCap,
  loadLogPrompts,
  loadUsage,
  loadWsBudgets,
  saveHardCap,
  saveLogPrompts,
  setWsBudget,
  subscribeUsage,
  summarizeByMonth,
  thisMonthTotal,
  thisMonthWorkspaceTotal,
  type UsageRecord,
} from "../aiUsageLog";

// Context so the Section component can read the currently-selected
// TOC slug without prop-drilling through every section call site.
const ActiveSectionContext = createContext<string>("");
import { invoke } from "@tauri-apps/api/core";

export function SettingsModal() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"form" | "json">("form");
  // Sections discovered from the rendered DOM after mount. Map slug
  // → display title. Drives the side TOC.
  const [toc, setToc] = useState<{ slug: string; title: string }[]>([]);
  const [activeSlug, setActiveSlug] = useState<string>("");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const settings = useEditorSettings();
  const [theme, setTheme] = useTheme();
  const activeId = useStore((s) => s.activeId);
  const sidebarSide = useStore((s) =>
    s.activeId ? s.loaded[s.activeId]?.layout.sidebarSide : "left",
  );
  const setSidebarSide = useStore((s) => s.setSidebarSide);

  useEffect(() => {
    return onSettingsOpen(() => {
      setOpen(true);
      setView("form");
    });
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Discover sections from the rendered DOM so the TOC stays in
  // sync with whatever Sections the form contains. Hidden sections
  // still mount (they just don't render content via the context),
  // so the discovery can find them all on first paint.
  useEffect(() => {
    if (!open || view !== "form") return;
    const body = bodyRef.current;
    if (!body) return;
    const t = window.setTimeout(() => {
      const sections = Array.from(
        body.querySelectorAll<HTMLElement>("[data-section]"),
      );
      const list = sections.map((s) => ({
        slug: s.dataset.section ?? "",
        title: s.dataset.title ?? "",
      }));
      setToc(list);
      // Land on the first section if no selection yet (or if the
      // previous selection no longer exists).
      setActiveSlug((cur) => {
        if (cur && list.some((t) => t.slug === cur)) return cur;
        return list[0]?.slug ?? "";
      });
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, view]);

  const jumpTo = (slug: string) => {
    setActiveSlug(slug);
    // Scroll to top of body — the section is now the only thing
    // visible, so any prior scroll position is irrelevant.
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  };

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
          <div className="settings-view-tabs" role="tablist" aria-label="Settings view">
            <button
              role="tab"
              aria-selected={view === "form"}
              className={`settings-view-tab ${view === "form" ? "active" : ""}`}
              onClick={() => setView("form")}
            >
              Form
            </button>
            <button
              role="tab"
              aria-selected={view === "json"}
              className={`settings-view-tab ${view === "json" ? "active" : ""}`}
              onClick={() => setView("json")}
              title="View / edit raw localStorage settings as JSON"
            >
              JSON
            </button>
          </div>
          <button
            className="settings-close"
            onClick={() => setOpen(false)}
            title="Close (Esc)"
          >
            ×
          </button>
        </div>
        {view === "json" ? (
          <SettingsJsonEditor onClose={() => setOpen(false)} />
        ) : (
        <div className="settings-layout">
          <aside className="settings-toc" aria-label="Settings sections">
            {toc.map((t) => (
              <button
                key={t.slug}
                className={`settings-toc-item ${activeSlug === t.slug ? "active" : ""}`}
                onClick={() => jumpTo(t.slug)}
              >
                {t.title}
              </button>
            ))}
          </aside>
          <div className="settings-body" ref={bodyRef}>
          <ActiveSectionContext.Provider value={activeSlug}>
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

          <Section title="AI Privacy — Exclude paths">
            <AIPrivacyEditor />
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

          <Section title="AI Usage — Cross-chat dashboard">
            <AIUsageDashboard />
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
          </ActiveSectionContext.Provider>
          </div>
        </div>
        )}
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

// Every localStorage key that the JSON editor surfaces. Listed
// explicitly so the editor doesn't dump UNRELATED keys (workspace
// state, chat history, AI session caches) — those are for app
// internals, not configuration the user should hand-edit.
const SETTINGS_KEYS = [
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

/** Serialise every known settings key out of localStorage as a
 *  pretty JSON object. Values are JSON-parsed when possible; raw
 *  strings otherwise so the editor doesn't choke on legacy values. */
function snapshotSettingsJson(): string {
  const out: Record<string, unknown> = {};
  for (const k of SETTINGS_KEYS) {
    const raw = localStorage.getItem(k);
    if (raw == null) continue;
    try {
      out[k] = JSON.parse(raw);
    } catch {
      out[k] = raw;
    }
  }
  return JSON.stringify(out, null, 2);
}

function SettingsJsonEditor({ onClose }: { onClose: () => void }) {
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

  const apply = () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setStatus({
        kind: "error",
        message: `Invalid JSON: ${e instanceof Error ? e.message : String(e)}`,
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
    // Confirm before applying — JSON edits can wipe credentials.
    const removed = SETTINGS_KEYS.filter(
      (k) => localStorage.getItem(k) != null && !(k in next),
    );
    if (removed.length > 0) {
      const ok = confirm(
        `These settings will be DELETED:\n\n  ${removed.join("\n  ")}\n\nApply anyway?`,
      );
      if (!ok) return;
    }
    let count = 0;
    for (const k of SETTINGS_KEYS) {
      if (k in next) {
        const v = next[k];
        try {
          localStorage.setItem(
            k,
            typeof v === "string" ? v : JSON.stringify(v),
          );
          count++;
        } catch {
          /* full — best-effort */
        }
      } else if (localStorage.getItem(k) != null) {
        localStorage.removeItem(k);
      }
    }
    setStatus({ kind: "ok", count });
    // Reload UI bits that read on mount: brute-force via a prompt
    // to refresh. Simpler than wiring pub-sub for every settings key.
    setTimeout(() => {
      if (
        confirm(
          "Settings applied. Reload the editor to make sure every component picks up the new values?",
        )
      ) {
        window.location.reload();
      }
    }, 100);
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
          onClick={apply}
        >
          Apply changes
        </button>
        <button className="sftp-btn" onClick={onClose}>
          Cancel
        </button>
      </div>
      <textarea
        className="settings-json-textarea"
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        wrap="off"
      />
      {status.kind === "error" && (
        <div className="sftp-profile-test sftp-profile-test-fail">
          ✗ {status.message}
        </div>
      )}
      {status.kind === "ok" && status.count > 0 && (
        <div className="sftp-profile-test sftp-profile-test-ok">
          ✓ Applied {status.count} setting{status.count === 1 ? "" : "s"}
        </div>
      )}
      <div className="settings-row settings-row-note">
        Edit any value, then <strong>Apply changes</strong>. Removing
        a key from the JSON deletes it from <code>localStorage</code>.
        Only configuration keys are shown — chat history, workspace
        state, and other internal data are not touched.
      </div>
    </div>
  );
}

function Section({
  title,
  children,
  id,
}: {
  title: string;
  children: React.ReactNode;
  /** Stable slug auto-derived from the title when omitted; the TOC
   *  uses this for selection. */
  id?: string;
}) {
  const slug =
    id ?? title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  // Read the currently-selected section from context. When it
  // doesn't match this section, render a marker div (so the TOC
  // discovery still finds us) but suppress the heavy children. The
  // marker keeps the data-section attribute the TOC needs.
  const activeSlug = useContext(ActiveSectionContext);
  const isActive = !activeSlug || activeSlug === slug;
  return (
    <div
      className={`settings-section ${isActive ? "is-active" : "is-hidden"}`}
      id={`settings-section-${slug}`}
      data-section={slug}
      data-title={title}
    >
      {isActive && (
        <>
          <div className="settings-section-title">{title}</div>
          <div className="settings-section-body">{children}</div>
        </>
      )}
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
  /** Optional path to an OpenSSH private key. Mirror of the panel field. */
  privateKeyPath?: string;
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
          privateKeyPath: p.privateKeyPath?.trim() || undefined,
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
          <Row label="Private key">
            <input
              className="sftp-field"
              value={editing.privateKeyPath ?? ""}
              placeholder="C:/Users/me/.ssh/id_ed25519 (optional — leave blank for password)"
              onChange={(e) =>
                setEditing({ ...editing, privateKeyPath: e.target.value })
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

// ---------- AI privacy exclusions ----------

function AIPrivacyEditor() {
  const [settings, setSettings] = useState(() => loadPrivacySettings());
  const [draft, setDraft] = useState("");
  const [test, setTest] = useState("");

  const persist = (next: typeof settings) => {
    setSettings(next);
    savePrivacySettings(next);
  };

  const addPattern = () => {
    const p = draft.trim();
    if (!p) return;
    if (settings.patterns.includes(p)) {
      setDraft("");
      return;
    }
    persist({ ...settings, patterns: [...settings.patterns, p] });
    setDraft("");
  };

  const removePattern = (p: string) => {
    persist({ ...settings, patterns: settings.patterns.filter((x) => x !== p) });
  };

  // Live test: enter a path, see whether the current effective list
  // would exclude it (and which pattern matched).
  const testMatch = test ? matchExclusion(test, effectivePatterns(settings)) : null;
  const effective = effectivePatterns(settings);

  return (
    <>
      <div className="settings-row settings-row-note">
        Files matching any of these globs are <strong>never</strong> sent
        to any AI provider — Claude Code's Read/Edit/Write/MultiEdit/
        NotebookEdit tool calls are denied with an explanation, the
        chat panel skips them when expanding <code>/file</code>, and a
        warning banner appears when an excluded file is the active
        editor buffer.
      </div>

      <Toggle
        label="Enable AI privacy exclusions"
        value={settings.enabled}
        onChange={(v) => persist({ ...settings, enabled: v })}
      />

      {settings.enabled && (
        <>
          <Toggle
            label="Include built-in defaults (.env, .ssh keys, secrets/, .aws/, etc.)"
            value={settings.useDefaults}
            onChange={(v) => persist({ ...settings, useDefaults: v })}
          />

          {settings.useDefaults && (
            <div className="settings-row settings-row-note">
              Built-in patterns ({DEFAULT_EXCLUSIONS.length}):{" "}
              {DEFAULT_EXCLUSIONS.map((p, i) => (
                <span key={p}>
                  <code>{p}</code>
                  {i < DEFAULT_EXCLUSIONS.length - 1 ? ", " : ""}
                </span>
              ))}
            </div>
          )}

          <div className="cc-allow-subhead">Your patterns</div>
          <div className="cc-allow-list">
            {settings.patterns.length === 0 ? (
              <div className="settings-row settings-row-note">
                No custom patterns. Use the input below to add one
                (git-style globs: <code>**/*.token</code>,{" "}
                <code>secrets/**</code>, <code>internal/**/*.ts</code>).
              </div>
            ) : (
              settings.patterns.map((p) => (
                <div key={p} className="cc-allow-row">
                  <code className="cc-allow-name">{p}</code>
                  <button
                    className="cc-allow-remove"
                    onClick={() => removePattern(p)}
                    title={`Stop excluding ${p}`}
                  >
                    Remove
                  </button>
                </div>
              ))
            )}
          </div>

          <Row label="Add pattern">
            <div style={{ display: "flex", gap: 6, width: "100%" }}>
              <input
                className="sftp-field"
                value={draft}
                placeholder="**/*.token"
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") addPattern();
                }}
              />
              <button
                className="sftp-btn sftp-btn-primary"
                onClick={addPattern}
                disabled={!draft.trim()}
              >
                Add
              </button>
            </div>
          </Row>

          <Row label="Test a path">
            <input
              className="sftp-field"
              value={test}
              placeholder="C:/Users/me/project/.env  →  see if it's excluded"
              onChange={(e) => setTest(e.target.value)}
            />
          </Row>
          {test && (
            <div
              className={`sftp-profile-test ${
                testMatch ? "sftp-profile-test-fail" : "sftp-profile-test-ok"
              }`}
            >
              {testMatch
                ? `✗ Blocked — matches pattern: ${testMatch}`
                : `✓ Not excluded — would be sent to AI`}
            </div>
          )}

          <div className="settings-row settings-row-note">
            {effective.length} effective pattern{effective.length === 1 ? "" : "s"} active.
          </div>
        </>
      )}
    </>
  );
}

// ---------- AI usage dashboard ----------

function AIUsageDashboard() {
  const [records, setRecords] = useState<UsageRecord[]>(() => loadUsage());
  const [cap, setCap] = useState<string>(() => {
    const v = loadHardCap();
    return v > 0 ? v.toString() : "";
  });
  const [logPrompts, setLogPrompts] = useState<boolean>(() => loadLogPrompts());
  const [wsBudgets, setWsBudgets] = useState<Record<string, number>>(() =>
    loadWsBudgets(),
  );
  const [openPromptIdx, setOpenPromptIdx] = useState<number | null>(null);
  const loadedWorkspaces = useStore((s) => s.loaded);

  useEffect(
    () =>
      subscribeUsage(() => {
        setRecords(loadUsage());
        setWsBudgets(loadWsBudgets());
      }),
    [],
  );

  const months = useMemo(() => summarizeByMonth(records), [records]);
  const thisMonth = useMemo(() => thisMonthTotal(records), [records]);
  const recent = useMemo(() => records.slice(-12).reverse(), [records]);

  // Workspace summary table — list any workspace currently loaded OR
  // any workspace that has either a budget OR recorded usage this
  // month, so caps and history don't disappear when a workspace is
  // closed.
  const wsSummary = useMemo(() => {
    const ids = new Set<string>();
    for (const k of Object.keys(loadedWorkspaces)) ids.add(k);
    for (const k of Object.keys(wsBudgets)) ids.add(k);
    for (const r of records) if (r.wsId) ids.add(r.wsId);
    return Array.from(ids).map((wsId) => ({
      wsId,
      name: loadedWorkspaces[wsId]?.meta?.name ?? "(closed workspace)",
      budget: wsBudgets[wsId] ?? 0,
      thisMonth: thisMonthWorkspaceTotal(wsId, records),
    }));
  }, [loadedWorkspaces, wsBudgets, records]);

  const persistCap = (next: string) => {
    setCap(next);
    const n = parseFloat(next);
    saveHardCap(Number.isFinite(n) && n > 0 ? n : 0);
  };

  const toggleLogPrompts = (v: boolean) => {
    setLogPrompts(v);
    saveLogPrompts(v);
  };

  const persistWsBudget = (wsId: string, next: string) => {
    const n = parseFloat(next);
    setWsBudget(wsId, Number.isFinite(n) && n > 0 ? n : 0);
    setWsBudgets(loadWsBudgets());
  };

  const capNum = parseFloat(cap);
  const capActive = Number.isFinite(capNum) && capNum > 0;
  const pctOfCap = capActive ? Math.min(100, (thisMonth / capNum) * 100) : 0;

  return (
    <>
      <div className="settings-row settings-row-note">
        Cross-chat ledger of every AI turn that produced a measurable
        cost. Used to enforce a monthly hard cap and show what's
        being spent where. <strong>Prompt + response contents are
        not stored</strong> — only timestamps, models, costs, and
        token counts.
      </div>

      <div className="ai-usage-summary">
        <div className="ai-usage-stat">
          <span className="ai-usage-num">${thisMonth.toFixed(2)}</span>
          <span className="ai-usage-lbl">This month</span>
        </div>
        <div className="ai-usage-stat">
          <span className="ai-usage-num">{records.length}</span>
          <span className="ai-usage-lbl">Logged turns (lifetime)</span>
        </div>
        <div className="ai-usage-stat">
          <span className="ai-usage-num">
            ${months.reduce((s, m) => s + m.total, 0).toFixed(2)}
          </span>
          <span className="ai-usage-lbl">Lifetime total</span>
        </div>
      </div>

      <Row label="Monthly hard cap (USD)">
        <div className="cc-budget-input">
          <span className="cc-budget-prefix">$</span>
          <input
            type="number"
            min="0"
            step="0.50"
            placeholder="0  (no cap)"
            value={cap}
            onChange={(e) => persistCap(e.target.value)}
            className="cc-budget-field"
          />
          <span className="cc-budget-suffix">USD</span>
        </div>
      </Row>
      {capActive && (
        <div className="ai-usage-bar">
          <div
            className="ai-usage-bar-fill"
            style={{
              width: `${pctOfCap}%`,
              background:
                pctOfCap >= 100
                  ? "#dc4646"
                  : pctOfCap >= 80
                    ? "#ffb061"
                    : "var(--accent)",
            }}
          />
        </div>
      )}
      <div className="settings-row settings-row-note">
        When this month's spend reaches the cap, new AI turns are
        blocked with a toast. Raise the cap or delete it to continue.
        Distinct from the per-chat warning budget below — that just
        toasts; this one stops sends.
      </div>

      {months.length > 0 && (
        <>
          <div className="cc-allow-subhead">By month</div>
          <div className="ai-usage-months">
            {months.slice(0, 6).map((m) => (
              <div key={m.month} className="ai-usage-month-row">
                <span className="ai-usage-month-name">{m.month}</span>
                <span className="ai-usage-month-total">
                  ${m.total.toFixed(2)}
                </span>
                <span className="ai-usage-month-detail">
                  {m.turns} turn{m.turns === 1 ? "" : "s"} ·{" "}
                  {(m.tokensIn + m.tokensOut).toLocaleString()} tokens
                </span>
                <span className="ai-usage-month-providers">
                  {Object.entries(m.perProvider)
                    .filter(([, v]) => v > 0)
                    .sort((a, b) => b[1] - a[1])
                    .map(([p, v]) => `${p} $${v.toFixed(2)}`)
                    .join(" · ") || "free"}
                </span>
              </div>
            ))}
          </div>
        </>
      )}

      <div className="cc-allow-subhead">Per-workspace budgets</div>
      <div className="settings-row settings-row-note">
        Per-workspace caps take precedence over the global cap above.
        Useful for "this client gets $50/month" billing per project.
        Workspaces show even when closed if they have a budget set or
        recorded usage this month.
      </div>
      {wsSummary.length === 0 ? (
        <div className="settings-row settings-row-note">
          No workspaces with usage or budget yet.
        </div>
      ) : (
        <div className="ai-usage-ws">
          {wsSummary.map((w) => (
            <div key={w.wsId} className="ai-usage-ws-row">
              <div className="ai-usage-ws-meta">
                <strong>{w.name}</strong>
                <span>{w.wsId}</span>
              </div>
              <div className="ai-usage-ws-spend">
                ${w.thisMonth.toFixed(2)}
                <span> spent this month</span>
              </div>
              <div className="cc-budget-input">
                <span className="cc-budget-prefix">$</span>
                <input
                  type="number"
                  min="0"
                  step="0.50"
                  placeholder="no cap"
                  value={w.budget > 0 ? String(w.budget) : ""}
                  onChange={(e) => persistWsBudget(w.wsId, e.target.value)}
                  className="cc-budget-field"
                />
                <span className="cc-budget-suffix">/mo</span>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="cc-allow-subhead">Prompt audit log</div>
      <Toggle
        label="Log full prompt text in audit trail"
        value={logPrompts}
        onChange={toggleLogPrompts}
      />
      <div className="settings-row settings-row-note">
        OFF (default) — only ts / provider / model / cost / tokens are
        logged.<br />
        ON — the user prompt for each turn is also stored
        (truncated to 1500 chars) so the recent-turns list shows
        previews and a "View" button. Older entries written before
        this toggle aren't backfilled.
      </div>

      {recent.length > 0 && (
        <>
          <div className="cc-allow-subhead">Recent turns</div>
          <div className="ai-usage-recent">
            {recent.map((r, i) => (
              <div key={r.ts + ":" + i}>
                <div className="ai-usage-recent-row">
                  <span className="ai-usage-recent-ts">
                    {new Date(r.ts).toLocaleString()}
                  </span>
                  <span className="ai-usage-recent-model">
                    <code>{r.provider}:{r.model}</code>
                  </span>
                  <span className="ai-usage-recent-tokens">
                    {(r.tokensIn + r.tokensOut).toLocaleString()} tok
                  </span>
                  <span className="ai-usage-recent-cost">
                    {r.costUsd > 0 ? `$${r.costUsd.toFixed(4)}` : "free"}
                  </span>
                </div>
                {r.prompt && (
                  <div className="ai-usage-recent-prompt">
                    <button
                      className="ai-usage-recent-prompt-toggle"
                      onClick={() =>
                        setOpenPromptIdx(openPromptIdx === i ? null : i)
                      }
                    >
                      {openPromptIdx === i ? "▾" : "▸"} {r.prompt.slice(0, 90)}
                      {r.prompt.length > 90 ? "…" : ""}
                    </button>
                    {openPromptIdx === i && (
                      <pre className="ai-usage-recent-prompt-full">
                        {r.prompt}
                      </pre>
                    )}
                  </div>
                )}
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
                "Delete the entire AI usage log? This is local-only, but you'll lose monthly history.",
              )
            ) {
              clearUsage();
            }
          }}
        >
          Clear log
        </button>
      </div>
    </>
  );
}
