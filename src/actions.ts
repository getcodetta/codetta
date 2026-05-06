import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { findPaneById, parseKey, useStore } from "./store";
import { openPalette } from "./paletteBus";
import { openSettings } from "./settingsBus";
import { getActiveEditor } from "./editorState";
import { alert as dialogAlert, confirm as dialogConfirm } from "./dialog";
import { fs } from "./ipc";
import {
  error as toastError,
  success as toastSuccess,
} from "./notify";
import {
  toggleAutoSave,
  toggleInsertFinalNewline,
  toggleMinimap,
  toggleTrimTrailingWhitespace,
  toggleWordWrap,
  zoomIn,
  zoomOut,
  zoomReset,
} from "./editorSettings";

function runEditorAction(actionId: string) {
  const ed = getActiveEditor();
  if (!ed) return;
  const a = ed.getAction(actionId);
  if (a) void a.run();
}

const s = () => useStore.getState();

/**
 * Scan every loaded workspace for files with unsaved buffer edits and,
 * if any exist, surface a danger-style confirm naming a sample of them.
 * Returns true if it's safe to proceed (no dirty files OR user confirmed),
 * false if the user backed out. Used by Reload Window, the title-bar
 * close button, and any future action that would silently discard work.
 *
 * `verb` is the present-tense action shown to the user — "Reload",
 * "Close", etc.
 */
export async function confirmDiscardUnsaved(verb: string): Promise<boolean> {
  let dirtyCount = 0;
  const dirtyNames: string[] = [];
  for (const ws of Object.values(s().loaded)) {
    for (const [path, f] of Object.entries(ws.files)) {
      if (f.contents !== f.original) {
        dirtyCount++;
        const name = path.replace(/\\/g, "/").split("/").pop();
        if (dirtyNames.length < 5 && name) dirtyNames.push(name);
      }
    }
  }
  if (dirtyCount === 0) return true;
  const sample = dirtyNames.join(", ");
  const more =
    dirtyCount > dirtyNames.length
      ? `, +${dirtyCount - dirtyNames.length} more`
      : "";
  return await dialogConfirm(
    `${verb} will discard unsaved changes in ${dirtyCount} file${dirtyCount === 1 ? "" : "s"}: ${sample}${more}\n\n${verb} anyway?`,
    {
      title: "Unsaved changes",
      okLabel: verb,
      cancelLabel: "Cancel",
      danger: true,
    },
  );
}

function activeFilePath(wsId: string | null): string | null {
  if (!wsId) return null;
  const ws = s().loaded[wsId];
  if (!ws) return null;
  const paneId = ws.layout.activePaneId;
  if (!paneId) return null;
  const pane =
    findPaneById(ws.layout.editorRoot, paneId) ??
    (ws.layout.bottomRoot ? findPaneById(ws.layout.bottomRoot, paneId) : null);
  if (!pane || pane.kind !== "tabs" || !pane.active) return null;
  const parsed = parseKey(pane.active);
  return parsed?.kind === "file" ? parsed.path : null;
}

export interface CommandSpec {
  id: string;
  label: string;
  category: "File" | "View" | "Terminal" | "AI" | "Help" | "Workspace" | "Edit";
  accel?: string;
  run: () => void | Promise<void>;
}

export const commands: CommandSpec[] = [
  {
    id: "file.open_folder",
    label: "Open Folder…",
    category: "File",
    accel: "Ctrl+O",
    run: async () => {
      const sel = await openDialog({ directory: true, multiple: false });
      if (typeof sel === "string") await s().openWorkspace(sel);
    },
  },
  {
    id: "file.close_workspace",
    label: "Close Workspace",
    category: "File",
    accel: "Ctrl+Shift+W",
    run: () => {
      const wsId = s().activeId;
      if (wsId) void s().closeWorkspace(wsId);
    },
  },
  {
    id: "file.save",
    label: "Save",
    category: "File",
    accel: "Ctrl+S",
    run: () => {
      const wsId = s().activeId;
      const path = activeFilePath(wsId);
      if (wsId && path) void s().saveFile(wsId, path);
    },
  },
  {
    id: "file.save_all",
    label: "Save All",
    category: "File",
    accel: "Ctrl+Shift+S",
    run: () => {
      const wsId = s().activeId;
      if (wsId) void s().saveAllFiles(wsId);
    },
  },
  {
    id: "file.quit",
    label: "Quit",
    category: "File",
    run: async () => {
      // Same dirty-file guard as Ctrl+R / × — Quit shouldn't silently
      // dump unsaved buffer state.
      if (!(await confirmDiscardUnsaved("Quit"))) return;
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        await getCurrentWindow().close();
      } catch {
        /* ignore */
      }
    },
  },
  {
    id: "view.toggle_sidebar",
    label: "Toggle Sidebar",
    category: "View",
    accel: "Ctrl+B",
    run: () => {
      const wsId = s().activeId;
      const ws = wsId ? s().loaded[wsId] : null;
      if (ws && wsId) s().setSidebarVisible(wsId, !ws.layout.sidebarVisible);
    },
  },
  {
    id: "view.toggle_panel",
    label: "Toggle Panel",
    category: "View",
    accel: "Ctrl+J",
    run: () => {
      const wsId = s().activeId;
      const ws = wsId ? s().loaded[wsId] : null;
      if (ws && wsId) s().setBottomVisible(wsId, !ws.layout.bottomVisible);
    },
  },
  {
    id: "view.files",
    label: "Show Explorer",
    category: "View",
    accel: "Ctrl+Shift+E",
    run: () => {
      const wsId = s().activeId;
      if (!wsId) return;
      s().setSidebarVisible(wsId, true);
      s().setSidebarView(wsId, "files");
    },
  },
  {
    id: "view.source_control",
    label: "Show Source Control",
    category: "View",
    accel: "Ctrl+Shift+G",
    run: () => {
      const wsId = s().activeId;
      if (!wsId) return;
      s().setSidebarVisible(wsId, true);
      s().setSidebarView(wsId, "git");
    },
  },
  {
    id: "view.search",
    label: "Search Files…",
    category: "View",
    accel: "Ctrl+Shift+F",
    run: () => openPalette("? "),
  },
  {
    id: "view.quick_open",
    label: "Quick Open File…",
    category: "View",
    accel: "Ctrl+P",
    run: () => openPalette(""),
  },
  {
    id: "view.tasks",
    label: "Show Tasks (npm scripts)",
    category: "View",
    run: () => {
      const wsId = s().activeId;
      if (!wsId) return;
      s().setSidebarVisible(wsId, true);
      s().setSidebarView(wsId, "tasks");
    },
  },
  {
    id: "view.ai",
    label: "Show AI Chat",
    category: "View",
    run: () => {
      const wsId = s().activeId;
      if (!wsId) return;
      s().setSidebarVisible(wsId, true);
      s().setSidebarView(wsId, "ai");
    },
  },
  {
    id: "view.todos",
    label: "Show TODO / FIXME",
    category: "View",
    accel: "Ctrl+Shift+T",
    run: () => {
      const wsId = s().activeId;
      if (!wsId) return;
      s().setSidebarVisible(wsId, true);
      s().setSidebarView(wsId, "todos");
    },
  },
  {
    id: "edit.format_document",
    label: "Format Document",
    category: "Edit",
    accel: "Ctrl+Shift+I",
    run: () => runEditorAction("editor.action.formatDocument"),
  },
  {
    id: "edit.goto_line",
    label: "Go to Line…",
    category: "Edit",
    accel: "Ctrl+G",
    run: () => runEditorAction("editor.action.gotoLine"),
  },
  {
    id: "edit.find_in_file",
    label: "Find in File",
    category: "Edit",
    accel: "Ctrl+F",
    run: () => runEditorAction("actions.find"),
  },
  {
    id: "edit.replace_in_file",
    label: "Replace in File",
    category: "Edit",
    accel: "Ctrl+H",
    run: () => runEditorAction("editor.action.startFindReplaceAction"),
  },
  {
    id: "edit.toggle_word_wrap",
    label: "Toggle Word Wrap",
    category: "View",
    accel: "Alt+Z",
    run: () => toggleWordWrap(),
  },
  {
    id: "edit.toggle_auto_save",
    label: "Toggle Auto-Save",
    category: "File",
    run: () => toggleAutoSave(),
  },
  {
    id: "view.toggle_minimap",
    label: "Toggle Minimap",
    category: "View",
    run: () => toggleMinimap(),
  },
  {
    id: "view.settings",
    label: "Open Settings…",
    category: "View",
    accel: "Ctrl+,",
    run: () => openSettings(),
  },
  {
    id: "edit.toggle_trim_trailing_ws",
    label: "Toggle: Trim Trailing Whitespace on Save",
    category: "File",
    run: () => toggleTrimTrailingWhitespace(),
  },
  {
    id: "edit.toggle_insert_final_newline",
    label: "Toggle: Insert Final Newline on Save",
    category: "File",
    run: () => toggleInsertFinalNewline(),
  },
  {
    id: "edit.goto_symbol",
    label: "Go to Symbol…",
    category: "Edit",
    accel: "Ctrl+Shift+O",
    run: () => runEditorAction("editor.action.quickOutline"),
  },
  {
    id: "edit.fold_all",
    label: "Fold All",
    category: "Edit",
    run: () => runEditorAction("editor.foldAll"),
  },
  {
    id: "edit.unfold_all",
    label: "Unfold All",
    category: "Edit",
    run: () => runEditorAction("editor.unfoldAll"),
  },
  {
    id: "edit.fold",
    label: "Fold",
    category: "Edit",
    run: () => runEditorAction("editor.fold"),
  },
  {
    id: "edit.unfold",
    label: "Unfold",
    category: "Edit",
    run: () => runEditorAction("editor.unfold"),
  },
  {
    id: "view.zoom_in",
    label: "Zoom In",
    category: "View",
    accel: "Ctrl+=",
    run: () => zoomIn(),
  },
  {
    id: "view.zoom_out",
    label: "Zoom Out",
    category: "View",
    accel: "Ctrl+-",
    run: () => zoomOut(),
  },
  {
    id: "view.zoom_reset",
    label: "Reset Zoom",
    category: "View",
    accel: "Ctrl+0",
    run: () => zoomReset(),
  },
  {
    id: "view.reveal_in_tree",
    label: "Reveal Active File in Explorer",
    category: "View",
    run: () => {
      const wsId = s().activeId;
      if (!wsId) return;
      const ws = s().loaded[wsId];
      const k = ws?.layout.activePaneId
        ? findPaneById(ws.layout.editorRoot, ws.layout.activePaneId)
        : null;
      const active = k && k.kind === "tabs" ? k.active : null;
      if (!active) return;
      const parsed = parseKey(active);
      if (parsed?.kind !== "file") return;
      // Expand all parent directories of the file in the tree.
      const parts = parsed.path
        .replace(/\\/g, "/")
        .split("/")
        .slice(0, -1);
      const expanded = new Set(ws!.layout.expandedDirs);
      let acc = "";
      for (const p of parts) {
        if (!p) continue;
        acc = acc ? `${acc}/${p}` : p;
        // Only add when path is absolute or matches workspace prefix.
      }
      // Simpler: walk path components from the workspace root.
      const root = ws!.meta.root.replace(/\\/g, "/").replace(/\/+$/, "");
      const rel = parsed.path
        .replace(/\\/g, "/")
        .replace(root + "/", "");
      const segs = rel.split("/").slice(0, -1);
      let cur = root;
      for (const seg of segs) {
        cur = `${cur}/${seg}`;
        expanded.add(cur);
      }
      s().setSidebarVisible(wsId, true);
      s().setSidebarView(wsId, "files");
      // Apply expanded dirs in one shot.
      useStore.setState((st) => {
        const w = st.loaded[wsId];
        if (!w) return st;
        return {
          loaded: {
            ...st.loaded,
            [wsId]: {
              ...w,
              layout: {
                ...w.layout,
                expandedDirs: Array.from(expanded),
              },
            },
          },
        };
      });
    },
  },
  {
    id: "view.reload",
    label: "Reload Window",
    category: "View",
    accel: "Ctrl+R",
    run: async () => {
      // Ctrl+R is the browser-refresh muscle memory; a stray hit shouldn't
      // silently throw away unsaved work. Chat history is already
      // refresh-safe (sessions are persisted + resumeable).
      if (!(await confirmDiscardUnsaved("Reload"))) return;
      window.location.reload();
    },
  },
  {
    id: "terminal.new_bottom",
    label: "New Terminal",
    category: "Terminal",
    accel: "Ctrl+`",
    run: () => {
      const wsId = s().activeId;
      if (wsId) s().addTerminal(wsId, "bottom");
    },
  },
  {
    id: "terminal.new_editor",
    label: "New Terminal in Editor Area",
    category: "Terminal",
    run: () => {
      const wsId = s().activeId;
      if (wsId) s().addTerminal(wsId, "editor");
    },
  },
  {
    id: "ai.new_chat",
    label: "New AI Chat",
    category: "AI",
    run: () => {
      const wsId = s().activeId;
      if (wsId) s().addAIChat(wsId, "editor");
    },
  },
  {
    id: "ai.claude_md_open",
    label: "Claude Code: Open project CLAUDE.md",
    category: "AI",
    run: () => void openProjectClaudeMd(),
  },
  {
    id: "ai.claude_md_init",
    label: "Claude Code: Init project CLAUDE.md (with scaffold)",
    category: "AI",
    run: () => void initProjectClaudeMd(),
  },
  {
    id: "ai.claude_md_user_open",
    label: "Claude Code: Open user CLAUDE.md (~/.claude/CLAUDE.md)",
    category: "AI",
    run: () => void openUserClaudeMd(),
  },
  {
    id: "help.repo",
    label: "GitHub Repository",
    category: "Help",
    run: async () => {
      try {
        await openUrl("https://github.com/getcodetta/codetta");
      } catch {
        /* ignore */
      }
    },
  },
  {
    id: "help.about",
    label: "About Codetta",
    category: "Help",
    run: () =>
      void dialogAlert(
        "Codetta — a lightweight Tauri-based code editor with first-class AI.\n\nMulti-workspace · multi-terminal (with pop-out) · integrated git · drag-and-drop splits · BYOK AI (Anthropic, OpenAI, Ollama, Claude Code).\n\nhttps://codetta.dev",
        { title: "About Codetta" },
      ),
  },
];

export function findCommand(id: string): CommandSpec | undefined {
  return commands.find((c) => c.id === id);
}

export function runCommand(id: string) {
  const c = findCommand(id);
  if (!c) return;
  void c.run();
}

export function commandsForCategory(
  cat: CommandSpec["category"],
): CommandSpec[] {
  return commands.filter((c) => c.category === cat);
}

// -----------------------------------------------------------------
// CLAUDE.md helpers
//
// CLAUDE.md is Claude Code's persistent per-project context file. The
// CLI auto-loads `<workspace>/CLAUDE.md` (and the user-level
// `~/.claude/CLAUDE.md`) into every prompt's system message. Most users
// don't know it exists — these palette commands surface it.
// -----------------------------------------------------------------

function joinPath(...parts: string[]): string {
  // Plain string join with normalization. We don't need OS-specific
  // separators here because the Tauri fs commands accept either on
  // Windows.
  return parts
    .map((p) => p.replace(/[\\/]+$/, ""))
    .filter(Boolean)
    .join("/");
}

async function ensureClaudeMd(absPath: string, scaffold: string | null): Promise<void> {
  const exists = await fs.exists(absPath).catch(() => false);
  if (!exists) {
    if (scaffold !== null) {
      await fs.writeFile(absPath, scaffold);
    } else {
      // Empty stub so the file exists for the editor.
      await fs.writeFile(absPath, "");
    }
  }
}

async function projectClaudeMdPath(): Promise<string | null> {
  const wsId = s().activeId;
  if (!wsId) {
    toastError("Open a workspace first.");
    return null;
  }
  const ws = s().loaded[wsId];
  if (!ws) return null;
  return joinPath(ws.meta.root, "CLAUDE.md");
}

async function userClaudeMdPath(): Promise<string | null> {
  try {
    const { homeDir, join } = await import("@tauri-apps/api/path");
    const home = await homeDir();
    return await join(home, ".claude", "CLAUDE.md");
  } catch (e) {
    toastError(`Cannot resolve home directory: ${e}`);
    return null;
  }
}

async function openInActiveWorkspace(absPath: string): Promise<void> {
  const wsId = s().activeId;
  if (!wsId) return;
  await s().openFile(wsId, absPath);
}

async function openProjectClaudeMd(): Promise<void> {
  const path = await projectClaudeMdPath();
  if (!path) return;
  try {
    await ensureClaudeMd(path, null);
    await openInActiveWorkspace(path);
  } catch (e) {
    toastError(`Failed to open CLAUDE.md: ${e}`);
  }
}

async function initProjectClaudeMd(): Promise<void> {
  const path = await projectClaudeMdPath();
  if (!path) return;
  const exists = await fs.exists(path).catch(() => false);
  if (exists) {
    const ok = await dialogConfirm(
      "CLAUDE.md already exists in this workspace. Overwrite with the scaffold? (Tip: open it instead via the palette to edit in place.)",
      {
        title: "Overwrite CLAUDE.md?",
        okLabel: "Overwrite",
        cancelLabel: "Cancel",
        danger: true,
      },
    );
    if (!ok) {
      await openInActiveWorkspace(path);
      return;
    }
  }
  const wsId = s().activeId!;
  const ws = s().loaded[wsId];
  const scaffold = buildClaudeMdScaffold(ws?.meta.name ?? "this project");
  try {
    await fs.writeFile(path, scaffold);
    await openInActiveWorkspace(path);
    toastSuccess("CLAUDE.md scaffolded — edit and save to use it on the next Claude Code turn.");
  } catch (e) {
    toastError(`Failed to write CLAUDE.md: ${e}`);
  }
}

async function openUserClaudeMd(): Promise<void> {
  const path = await userClaudeMdPath();
  if (!path) return;
  try {
    // Make sure the ~/.claude directory exists. Best-effort — the user
    // probably already has it after running `claude /login`. We don't
    // create the file pre-emptively; the editor handles non-existent
    // paths by opening an empty buffer the user saves.
    await ensureClaudeMd(path, null);
    await openInActiveWorkspace(path);
  } catch (e) {
    toastError(`Failed to open ~/.claude/CLAUDE.md: ${e}`);
  }
}

function buildClaudeMdScaffold(projectName: string): string {
  return `# ${projectName} — project context for Claude Code

> This file is automatically included by the Claude Code CLI on every
> prompt. Keep it short and high-signal — anything in here costs tokens
> on every turn. Delete sections you don't need.

## What this project is

<one-paragraph elevator pitch — what does the codebase do, who uses it, what's the current state>

## How to run / build / test

<exact commands the agent should use, e.g.:>

\`\`\`
npm install
npm run dev          # local dev server
npm run build        # production build
npm test             # full test suite
\`\`\`

## Conventions

- <language version, formatter, linter — e.g. "TypeScript strict mode, Prettier defaults, ESLint with @typescript-eslint">
- <commit message style, branch naming>
- <test layout — where tests live, what runner>

## Architecture in 5 bullets

- <where do feature requests typically land — frontend? backend? a specific service?>
- <key state stores / data flow>
- <external services this app talks to>
- <build / deploy pipeline>
- <anything subtle that an outsider would get wrong>

## Things to avoid

- <foot-guns specific to this codebase, e.g. "don't import from src/legacy/*">
- <files that look editable but aren't, e.g. generated code>
- <tests that are flaky and not worth chasing>
`;
}
