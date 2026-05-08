import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  setAutoClosingBrackets,
  setEditorSettings,
  setRenderWhitespace,
  useEditorSettings,
} from "../editorSettings";
import type { EditorSettings } from "../editorSettings";
import {
  IDLE_BUFFER_MAX,
  IDLE_BUFFER_MIN,
  IDLE_TERMINAL_MAX,
  IDLE_TERMINAL_MIN,
  setFootprintSettings,
  useFootprintSettings,
} from "../footprintSettings";
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
import { Icon } from "./Icon";
// Canonical templates store — same module the palette commands
// (`ai.save_template` / `ai.run_template`) read from, so saves here
// surface there and vice versa.
import {
  type AITemplate,
  addTemplate,
  getTemplates,
  removeTemplate,
  subscribeTemplates,
} from "../aiTemplates";

// Per-row local draft state. Edits commit on blur (or on Enter for the
// label input). We can't mutate templates in place — the underlying
// store has no updateTemplate — so each blur-commit removes the old
// row and re-adds a new one. The new entry sorts to the top of the
// list, which is fine for an editor that only ever shows ~ a dozen
// templates and a noticeable signal that the save took effect.
function commitEdit(
  oldId: string,
  draftLabel: string,
  draftPrompt: string,
): string {
  const label = draftLabel.trim() || "Untitled";
  const prompt = draftPrompt;
  removeTemplate(oldId);
  const created = addTemplate(label, prompt);
  return created.id;
}

function AITemplatesEditor() {
  // Subscribe to the underlying store so external changes (palette
  // commands, future sync) reflect here without a manual refresh.
  const [templates, setTemplates] = useState<AITemplate[]>(() =>
    getTemplates(),
  );
  useEffect(() => {
    const unsub = subscribeTemplates(() => setTemplates(getTemplates()));
    return () => {
      unsub();
    };
  }, []);

  // Local drafts keyed by current template id — typing into a row
  // updates only this map, so re-sorts in the underlying store don't
  // yank focus mid-edit. We resolve the live value as `draft ?? stored`
  // when rendering. Map key swaps to the new id after commit.
  const [drafts, setDrafts] = useState<
    Record<string, { label: string; prompt: string }>
  >({});

  const setDraftField = (
    id: string,
    field: "label" | "prompt",
    value: string,
  ) => {
    setDrafts((d) => {
      const cur = d[id] ?? {
        label:
          templates.find((t) => t.id === id)?.label ?? "",
        prompt:
          templates.find((t) => t.id === id)?.prompt ?? "",
      };
      return { ...d, [id]: { ...cur, [field]: value } };
    });
  };

  const flushDraft = (id: string) => {
    const draft = drafts[id];
    if (!draft) return;
    const original = templates.find((t) => t.id === id);
    if (!original) return;
    const labelChanged = draft.label !== original.label;
    const promptChanged = draft.prompt !== original.prompt;
    if (!labelChanged && !promptChanged) {
      // No-op blur; drop the draft so the row reads from the store.
      setDrafts((d) => {
        if (!(id in d)) return d;
        const { [id]: _drop, ...rest } = d;
        void _drop;
        return rest;
      });
      return;
    }
    commitEdit(id, draft.label, draft.prompt);
    // Drop the old draft entry — the new template gets a new id, and
    // the list re-render will pick the stored values up.
    setDrafts((d) => {
      if (!(id in d)) return d;
      const { [id]: _drop, ...rest } = d;
      void _drop;
      return rest;
    });
  };

  const onAdd = () => {
    const created = addTemplate("New template", "");
    // Open the new row immediately for editing by seeding a draft.
    setDrafts((d) => ({
      ...d,
      [created.id]: { label: created.label, prompt: created.prompt },
    }));
  };

  const onDelete = (id: string) => {
    removeTemplate(id);
    setDrafts((d) => {
      if (!(id in d)) return d;
      const { [id]: _drop, ...rest } = d;
      void _drop;
      return rest;
    });
  };

  // Canonical store has no createdAt — preserve the array order it
  // returns (newest at the END since addTemplate pushes; reverse so
  // the freshest entry stays on top of the editor list).
  const sorted = useMemo(() => templates.slice().reverse(), [templates]);

  if (sorted.length === 0) {
    return (
      <>
        <div className="settings-row settings-row-note">
          No templates yet. Use "AI: Save AI Template…" from the palette,
          or add one here.
        </div>
        <div className="settings-row" style={{ justifyContent: "flex-end" }}>
          <button className="settings-toc-item" onClick={onAdd}>
            + Add template
          </button>
        </div>
      </>
    );
  }

  return (
    <>
      {sorted.map((t) => {
        const draft = drafts[t.id];
        const labelValue = draft?.label ?? t.label;
        const promptValue = draft?.prompt ?? t.prompt;
        return (
          <div
            key={t.id}
            className="settings-row settings-row-multiline"
            style={{
              flexDirection: "column",
              alignItems: "stretch",
              gap: 6,
            }}
          >
            <div
              style={{
                display: "flex",
                gap: 8,
                alignItems: "center",
              }}
            >
              <input
                type="text"
                value={labelValue}
                onChange={(e) =>
                  setDraftField(t.id, "label", e.target.value)
                }
                onBlur={() => flushDraft(t.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    (e.currentTarget as HTMLInputElement).blur();
                  }
                }}
                placeholder="Template label"
                spellCheck={false}
                style={{ flex: 1, minWidth: 0 }}
              />
              <button
                className="settings-toc-item"
                onClick={() => onDelete(t.id)}
                title="Delete template"
                style={{ flex: "none" }}
              >
                Delete
              </button>
            </div>
            <textarea
              value={promptValue}
              onChange={(e) =>
                setDraftField(t.id, "prompt", e.target.value)
              }
              onBlur={() => flushDraft(t.id)}
              placeholder="Prompt body — supports plain text. Saved on blur."
              spellCheck={false}
              rows={3}
              style={{
                width: "100%",
                resize: "vertical",
                minHeight: 60,
                fontFamily: "var(--font-mono, monospace)",
                fontSize: 12,
              }}
            />
          </div>
        );
      })}
      <div className="settings-row" style={{ justifyContent: "flex-end" }}>
        <button className="settings-toc-item" onClick={onAdd}>
          + Add template
        </button>
      </div>
    </>
  );
}

export function SettingsModal() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"form" | "json">("form");
  // Sections discovered from the rendered DOM after mount. Map slug
  // → display title. Drives the side TOC.
  const [toc, setToc] = useState<{ slug: string; title: string }[]>([]);
  const [activeSlug, setActiveSlug] = useState<string>("");
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const settings = useEditorSettings();
  const footprint = useFootprintSettings();
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
            <Icon name="x" size={14} />
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
            <Row label="Auto-closing brackets">
              <div className="settings-segmented">
                {(
                  [
                    { v: "always", label: "Always" },
                    { v: "languageDefined", label: "Language-defined" },
                    { v: "never", label: "Never" },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.v}
                    className={`segmented-btn ${
                      settings.autoClosingBrackets === opt.v ? "active" : ""
                    }`}
                    onClick={() => setAutoClosingBrackets(opt.v)}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="Render whitespace">
              <div className="settings-segmented">
                {(
                  [
                    ["none", "Off"],
                    ["boundary", "Boundary"],
                    ["selection", "Selection"],
                    ["all", "All"],
                  ] as [EditorSettings["renderWhitespace"], string][]
                ).map(([value, label]) => (
                  <button
                    key={value}
                    className={`segmented-btn ${settings.renderWhitespace === value ? "active" : ""}`}
                    onClick={() => setRenderWhitespace(value)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </Row>
            <Toggle
              label="Sticky scroll header"
              value={settings.stickyScroll}
              onChange={(v) => setEditorSettings({ stickyScroll: v })}
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
            <Toggle
              label="Format on save"
              value={settings.formatOnSave}
              onChange={(v) => setEditorSettings({ formatOnSave: v })}
            />
          </Section>

          <Section title="Footprint">
            <Toggle
              label="Drop idle file buffers from memory"
              value={footprint.idleBufferUnloadEnabled}
              onChange={(v) =>
                setFootprintSettings({ idleBufferUnloadEnabled: v })
              }
            />
            <Row label="Idle minutes (file buffer)">
              <input
                type="number"
                min={IDLE_BUFFER_MIN}
                max={IDLE_BUFFER_MAX}
                value={footprint.idleBufferUnloadMinutes}
                onChange={(e) =>
                  setFootprintSettings({
                    idleBufferUnloadMinutes: Math.max(
                      IDLE_BUFFER_MIN,
                      Math.min(
                        IDLE_BUFFER_MAX,
                        Number(e.target.value) || 30,
                      ),
                    ),
                  })
                }
                className="settings-num"
                disabled={!footprint.idleBufferUnloadEnabled}
              />
            </Row>
            <Toggle
              label="Close idle terminals automatically"
              value={footprint.idleTerminalCloseEnabled}
              onChange={(v) =>
                setFootprintSettings({ idleTerminalCloseEnabled: v })
              }
            />
            <Row label="Idle minutes (terminal)">
              <input
                type="number"
                min={IDLE_TERMINAL_MIN}
                max={IDLE_TERMINAL_MAX}
                value={footprint.idleTerminalCloseMinutes}
                onChange={(e) =>
                  setFootprintSettings({
                    idleTerminalCloseMinutes: Math.max(
                      IDLE_TERMINAL_MIN,
                      Math.min(
                        IDLE_TERMINAL_MAX,
                        Number(e.target.value) || 60,
                      ),
                    ),
                  })
                }
                className="settings-num"
                disabled={!footprint.idleTerminalCloseEnabled}
              />
            </Row>
            <div className="settings-row settings-row-note">
              Trade-off: a tab pointing at a dropped buffer triggers a
              fresh disk read on click. Worth it for memory wins on
              long-running sessions.
            </div>
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

          <Section title="AI Templates">
            <AITemplatesEditor />
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

