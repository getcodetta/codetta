import { useEffect, useState } from "react";
import { useStore } from "../store";
import { useEditorState } from "../editorState";
import { useTheme, type ThemeMode } from "../theme";
import { runCommand } from "../actions";
import { useEditorSettings } from "../editorSettings";
import { basename } from "../pathUtils";
import { Icon, type IconName } from "./Icon";
import { git as gitApi, type GitStatus } from "../ipc";
import { openPalette } from "../paletteBus";

interface Props {
  onOpenPalette: () => void;
}

const themeNext: Record<ThemeMode, ThemeMode> = {
  dark: "light",
  light: "system",
  system: "dark",
};

const themeIcon: Record<ThemeMode, IconName> = {
  light: "sun",
  dark: "moon",
  system: "monitor",
};

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
  // Per-workspace footprint glance: how many file buffers and PTYs the
  // active workspace is holding. Useful for noticing when a session has
  // accumulated more than expected — esp. terminals, which keep PTYs
  // alive in the background. Hidden when both are zero (clean slate).
  const bufCount = ws ? Object.keys(ws.files).length : 0;
  const termCount = ws ? Object.keys(ws.terminals).length : 0;
  const showFootprint = bufCount > 0 || termCount > 0;
  const sidebarVisible = ws?.layout.sidebarVisible ?? true;
  const bottomVisible = ws?.layout.bottomVisible ?? true;
  const sidebarView = ws?.layout.sidebarView ?? "files";

  // Lightweight git status pulled every 15s — branch + ahead/behind +
  // working-tree change count for the status-bar chip. The Source
  // Control panel does its own richer fetch when open; this is the
  // always-on glance.
  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const wsRoot = ws?.meta.root;
  useEffect(() => {
    if (!wsRoot) {
      setGitStatus(null);
      return;
    }
    let cancelled = false;
    const tick = async () => {
      try {
        const s = await gitApi.status(wsRoot);
        if (!cancelled) setGitStatus(s);
      } catch {
        if (!cancelled) setGitStatus(null);
      }
    };
    void tick();
    const id = window.setInterval(tick, 15000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [wsRoot]);

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
            {basename(editorState.filePath)}
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
        {gitStatus?.is_repo && gitStatus.branch && (
          <button
            type="button"
            className="sb-item sb-git"
            title={(() => {
              const parts: string[] = [`Branch: ${gitStatus.branch}`];
              if (gitStatus.upstream) {
                parts.push(`tracking ${gitStatus.upstream}`);
              }
              if (gitStatus.ahead || gitStatus.behind) {
                parts.push(
                  `${gitStatus.ahead} ahead, ${gitStatus.behind} behind`,
                );
              }
              if (gitStatus.files.length > 0) {
                parts.push(
                  `${gitStatus.files.length} changed file${
                    gitStatus.files.length > 1 ? "s" : ""
                  }`,
                );
              }
              parts.push("(click for Source Control)");
              return parts.join(" · ");
            })()}
            onClick={() => runCommand("view.source_control")}
          >
            <Icon name="git-branch" size={11} />
            <span>{gitStatus.branch}</span>
            {(gitStatus.ahead > 0 || gitStatus.behind > 0) && (
              <span className="sb-git-trail">
                {gitStatus.ahead > 0 && ` ↑${gitStatus.ahead}`}
                {gitStatus.behind > 0 && ` ↓${gitStatus.behind}`}
              </span>
            )}
            {gitStatus.files.length > 0 && (
              <span className="sb-git-trail">·{gitStatus.files.length}</span>
            )}
          </button>
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

        {showFootprint && (
          <button
            type="button"
            className="sb-item sb-footprint"
            title={`${bufCount} open file buffer${
              bufCount === 1 ? "" : "s"
            }, ${termCount} open terminal${
              termCount === 1 ? "" : "s"
            } — click for footprint details`}
            aria-label={`Workspace footprint: ${bufCount} file buffer${
              bufCount === 1 ? "" : "s"
            }, ${termCount} terminal${termCount === 1 ? "" : "s"}`}
            onClick={() => openPalette("footprint")}
          >
            <Icon name="info" size={11} />
            <span className="sb-footprint-num">buf{bufCount}</span>
            <span className="sb-footprint-sep">·</span>
            <span className="sb-footprint-num">term{termCount}</span>
          </button>
        )}

        <button
          className={`sb-btn ${sidebarVisible && sidebarView === "files" ? "active" : ""}`}
          title="Toggle Explorer (Ctrl+B)"
          aria-label="Toggle Explorer"
          aria-pressed={sidebarVisible && sidebarView === "files"}
          disabled={!activeId}
          onClick={() => runCommand("view.toggle_sidebar")}
        >
          <Icon name="folder" />
        </button>
        <button
          className={`sb-btn ${sidebarVisible && sidebarView === "git" ? "active" : ""}`}
          title="Source Control (Ctrl+Shift+G)"
          aria-label="Source Control"
          aria-pressed={sidebarVisible && sidebarView === "git"}
          disabled={!activeId}
          onClick={() => runCommand("view.source_control")}
        >
          <Icon name="git-branch" />
        </button>
        <button
          className={`sb-btn ${bottomVisible ? "active" : ""}`}
          title="Toggle Panel (Ctrl+J)"
          aria-label="Toggle bottom panel"
          aria-pressed={bottomVisible}
          disabled={!activeId}
          onClick={() => runCommand("view.toggle_panel")}
        >
          <Icon name="panel-bottom" />
        </button>
        <button
          className="sb-btn"
          title="New Terminal (Ctrl+`)"
          aria-label="New terminal"
          disabled={!activeId}
          onClick={() => runCommand("terminal.new_bottom")}
        >
          <Icon name="terminal" />
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
          <Icon name={settings.autoSave ? "save-auto" : "save"} />
        </button>
        <button
          className="sb-btn"
          title="Save (Ctrl+S)"
          aria-label="Save current file"
          disabled={!editorState.filePath}
          onClick={() => runCommand("file.save")}
        >
          <Icon name="save" />
        </button>
        <button
          className="sb-btn"
          title="Open Folder (Ctrl+O)"
          aria-label="Open folder"
          onClick={() => runCommand("file.open_folder")}
        >
          <Icon name="folder-open" />
        </button>
        <button
          className="sb-btn"
          title="Command Palette (Ctrl+P)"
          aria-label="Command palette"
          onClick={onOpenPalette}
        >
          <Icon name="command" />
        </button>
        <button
          className="sb-btn"
          title="Settings (Ctrl+,)"
          aria-label="Settings"
          onClick={() => runCommand("view.settings")}
        >
          <Icon name="settings" />
        </button>
        <button
          className="sb-btn sb-theme"
          title={`Theme: ${theme} — click to cycle`}
          aria-label={`Theme: ${theme}, click to cycle`}
          onClick={cycleTheme}
        >
          <Icon name={themeIcon[theme]} />
        </button>
      </div>
    </div>
  );
}
