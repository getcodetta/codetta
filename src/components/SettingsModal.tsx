import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  setEditorSettings,
  useEditorSettings,
} from "../editorSettings";
import { useTheme, type ThemeMode } from "../theme";
import { onSettingsOpen } from "../settingsBus";
import { useStore } from "../store";
import { PROVIDERS } from "../providers";
import { McpServerBrowser } from "./McpServerBrowser";
import { SettingsJsonEditor } from "./settingsJsonEditor";
import {
  ActiveSectionContext,
  ApiKeyRow,
  Row,
  Section,
  Toggle,
  ToolPermissionRow,
} from "./settingsBits";
import {
  AIPrivacyEditor,
  AIUsageDashboard,
} from "./aiSettingsSections";
import {
  ClaudeCodeAlwaysAllowEditor,
  ClaudeCodeBudgetEditor,
} from "./claudeCodeSettings";
import { SftpProfilesEditor } from "./sftpProfilesEditor";

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
        aria-labelledby="settings-modal-title"
      >
        <div className="settings-header">
          <span id="settings-modal-title">Settings</span>
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
            aria-label="Close settings"
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

