import { useStore } from "../store";
import { useEditorState } from "../editorState";
import { useTheme, type ThemeMode } from "../theme";
import { runCommand } from "../actions";
import { useEditorSettings } from "../editorSettings";

interface Props {
  onOpenPalette: () => void;
}

const themeNext: Record<ThemeMode, ThemeMode> = {
  dark: "light",
  light: "system",
  system: "dark",
};

const themeIcon: Record<ThemeMode, string> = {
  light: "☀",
  dark: "🌙",
  system: "⚙",
};

function shortPath(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

export function StatusBar({ onOpenPalette }: Props) {
  const editorState = useEditorState();
  const [theme, setTheme] = useTheme();
  const settings = useEditorSettings();
  const activeId = useStore((s) => s.activeId);
  const ws = useStore((s) =>
    s.activeId ? s.loaded[s.activeId] : null,
  );
  const dirtyCount = ws
    ? Object.values(ws.files).filter((f) => f.contents !== f.original).length
    : 0;
  const sidebarVisible = ws?.layout.sidebarVisible ?? true;
  const bottomVisible = ws?.layout.bottomVisible ?? true;
  const sidebarView = ws?.layout.sidebarView ?? "files";

  const cycleTheme = () => setTheme(themeNext[theme]);

  return (
    <div className="statusbar" role="status">
      <div className="sb-section sb-left">
        {ws && (
          <span className="sb-item sb-ws" title={ws.meta.root}>
            <span className="sb-icon">⌥</span>
            {ws.meta.name}
          </span>
        )}
        {editorState.filePath && (
          <span
            className="sb-item sb-file"
            title={editorState.filePath}
          >
            {shortPath(editorState.filePath)}
          </span>
        )}
        {dirtyCount > 0 && (
          <span
            className="sb-item sb-dirty"
            title={`${dirtyCount} unsaved file${dirtyCount > 1 ? "s" : ""}`}
          >
            ● {dirtyCount}
          </span>
        )}
      </div>

      <div className="sb-section sb-right">
        {editorState.filePath && (
          <>
            <span className="sb-item">
              Ln {editorState.line}, Col {editorState.col}
            </span>
            {editorState.language && (
              <span className="sb-item">{editorState.language}</span>
            )}
          </>
        )}

        <button
          className={`sb-btn ${sidebarVisible && sidebarView === "files" ? "active" : ""}`}
          title="Toggle Explorer (Ctrl+B)"
          aria-label="Toggle Explorer"
          aria-pressed={sidebarVisible && sidebarView === "files"}
          disabled={!activeId}
          onClick={() => runCommand("view.toggle_sidebar")}
        >
          📁
        </button>
        <button
          className={`sb-btn ${sidebarVisible && sidebarView === "git" ? "active" : ""}`}
          title="Source Control (Ctrl+Shift+G)"
          aria-label="Source Control"
          aria-pressed={sidebarVisible && sidebarView === "git"}
          disabled={!activeId}
          onClick={() => runCommand("view.source_control")}
        >
          ⎇
        </button>
        <button
          className={`sb-btn ${bottomVisible ? "active" : ""}`}
          title="Toggle Panel (Ctrl+J)"
          aria-label="Toggle bottom panel"
          aria-pressed={bottomVisible}
          disabled={!activeId}
          onClick={() => runCommand("view.toggle_panel")}
        >
          ▭
        </button>
        <button
          className="sb-btn"
          title="New Terminal (Ctrl+`)"
          aria-label="New terminal"
          disabled={!activeId}
          onClick={() => runCommand("terminal.new_bottom")}
        >
          ›_
        </button>
        <button
          className={`sb-btn ${settings.autoSave ? "active" : ""}`}
          title={
            settings.autoSave
              ? "Auto-save ON (click to disable)"
              : "Auto-save OFF (click to enable)"
          }
          aria-label={settings.autoSave ? "Disable auto-save" : "Enable auto-save"}
          aria-pressed={settings.autoSave}
          onClick={() => runCommand("edit.toggle_auto_save")}
        >
          {settings.autoSave ? "⏱" : "💾"}
        </button>
        <button
          className="sb-btn"
          title="Save (Ctrl+S)"
          aria-label="Save current file"
          disabled={!editorState.filePath}
          onClick={() => runCommand("file.save")}
        >
          💾
        </button>
        <button
          className="sb-btn"
          title="Open Folder (Ctrl+O)"
          aria-label="Open folder"
          onClick={() => runCommand("file.open_folder")}
        >
          📂
        </button>
        <button
          className="sb-btn"
          title="Command Palette (Ctrl+P)"
          aria-label="Command palette"
          onClick={onOpenPalette}
        >
          ⌖
        </button>
        <button
          className="sb-btn"
          title="Settings (Ctrl+,)"
          aria-label="Settings"
          onClick={() => runCommand("view.settings")}
        >
          ⚙
        </button>
        <button
          className="sb-btn sb-theme"
          title={`Theme: ${theme} — click to cycle`}
          aria-label={`Theme: ${theme}, click to cycle`}
          onClick={cycleTheme}
        >
          {themeIcon[theme]}
        </button>
      </div>
    </div>
  );
}
