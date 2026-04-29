import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { openUrl } from "@tauri-apps/plugin-opener";
import { findPaneById, parseKey, useStore } from "./store";
import { openPalette } from "./paletteBus";
import { openSettings } from "./settingsBus";
import { getActiveEditor } from "./editorState";
import { alert as dialogAlert } from "./dialog";
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
  category: "File" | "View" | "Terminal" | "Help" | "Workspace" | "Edit";
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
    run: () => window.location.reload(),
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
    id: "help.repo",
    label: "GitHub Repository",
    category: "Help",
    run: async () => {
      try {
        await openUrl("https://github.com/suppledigital/lite-coder-pro");
      } catch {
        /* ignore */
      }
    },
  },
  {
    id: "help.about",
    label: "About Lite Coder Pro",
    category: "Help",
    run: () =>
      void dialogAlert(
        "A lightweight Tauri-based code editor.\n\nMulti-workspace · multi-terminal · integrated git · drag-and-drop splits.",
        { title: "Lite Coder Pro" },
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
