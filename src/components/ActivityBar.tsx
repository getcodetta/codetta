import { useRef, useState } from "react";
import { createPortal } from "react-dom";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useStore, type SidebarView } from "../store";
import { AIIcon } from "./AIIcon";
import { Icon } from "./Icon";

function initials(name: string): string {
  const parts = name.split(/[\s\-_.]+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return name.slice(0, 2).toUpperCase();
}

export function ActivityBar() {
  const openIds = useStore((s) => s.openIds);
  const activeId = useStore((s) => s.activeId);
  const loaded = useStore((s) => s.loaded);
  const setActive = useStore((s) => s.setActiveWorkspace);
  const closeWs = useStore((s) => s.closeWorkspace);
  const recent = useStore((s) => s.recent);
  const removeRecent = useStore((s) => s.removeFromRecent);
  const openWs = useStore((s) => s.openWorkspace);
  const setSidebarVisible = useStore((s) => s.setSidebarVisible);

  const ws = activeId ? loaded[activeId] : null;
  const sections = ws?.layout.sidebarSections ?? [];
  const sidebarVisible = ws?.layout.sidebarVisible ?? true;
  const sidebarSide = ws?.layout.sidebarSide ?? "left";
  const toggleSidebarSection = useStore((s) => s.toggleSidebarSection);
  const setSidebarSide = useStore((s) => s.setSidebarSide);
  const setAIPanelVisible = useStore((s) => s.setAIPanelVisible);
  const aiPanelVisible = ws?.layout.aiPanelVisible ?? false;
  const hasSection = (v: SidebarView) =>
    sections.some((s) => s.view === v && !s.collapsed);
  const sectionActive = (v: SidebarView) => sidebarVisible && hasSection(v);

  const [addOpen, setAddOpen] = useState(false);
  const addBtnRef = useRef<HTMLButtonElement>(null);

  const switchView = (v: SidebarView) => {
    if (!activeId) return;
    // If the sidebar is hidden (e.g. Ctrl+B, or auto-hidden because the
    // last section was removed), the click should *reveal* the panel, not
    // toggle the section away. Only add the section if it isn't already
    // there; if it is, the existing one just becomes visible again.
    if (!sidebarVisible) {
      setSidebarVisible(activeId, true);
      const present = sections.some((s) => s.view === v);
      if (!present) toggleSidebarSection(activeId, v);
      return;
    }
    // Sidebar is visible — standard toggle. Removing the only remaining
    // section auto-hides the sidebar (handled in the store action).
    toggleSidebarSection(activeId, v);
  };

  const recentNotOpen = recent.filter((w) => !openIds.includes(w.id));

  return (
    <div
      className="activity-bar"
      onContextMenu={(e) => {
        e.preventDefault();
        if (!activeId) return;
        setSidebarSide(activeId, sidebarSide === "left" ? "right" : "left");
      }}
      title="Right-click to flip sidebar to the other side"
    >
      <div className="activity-section ws-list">
        {openIds.map((id) => {
          const meta = loaded[id]?.meta;
          if (!meta) return null;
          const isActive = id === activeId;
          return (
            <div
              key={id}
              className={`ws-icon ${isActive ? "active" : ""}`}
              title={`${meta.name}\n${meta.root}`}
              role="button"
              tabIndex={0}
              aria-label={`Switch to workspace ${meta.name}`}
              aria-pressed={isActive}
              onClick={() => void setActive(id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  void setActive(id);
                }
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  void closeWs(id);
                }
              }}
            >
              <span className="ws-icon-text">{initials(meta.name)}</span>
              <button
                className="ws-icon-close"
                onClick={(e) => {
                  e.stopPropagation();
                  void closeWs(id);
                }}
                title="Close workspace"
                aria-label={`Close workspace ${meta.name}`}
              >
                ×
              </button>
            </div>
          );
        })}
        <button
          ref={addBtnRef}
          className="ws-icon ws-icon-add"
          title="Open workspace"
          aria-label="Open workspace"
          aria-haspopup="menu"
          aria-expanded={addOpen}
          onClick={() => setAddOpen((v) => !v)}
        >
          +
        </button>
      </div>

      <div className="activity-sep" />

      <div className="activity-section view-icons" role="toolbar" aria-label="Sidebar sections">
        <button
          className={`activity-icon ${sectionActive("files") ? "active" : ""}`}
          title="Explorer (Ctrl+Shift+E) — click to toggle section"
          aria-label="Explorer"
          aria-pressed={sectionActive("files")}
          onClick={() => switchView("files")}
          disabled={!activeId}
        >
          <Icon name="folder" size={20} />
        </button>
        <button
          className={`activity-icon ${sectionActive("search") ? "active" : ""}`}
          title="Search (Ctrl+Shift+F) — full text search across the workspace"
          aria-label="Search"
          aria-pressed={sectionActive("search")}
          onClick={() => switchView("search")}
          disabled={!activeId}
        >
          <Icon name="search" size={20} />
        </button>
        <button
          className={`activity-icon ${sectionActive("git") ? "active" : ""}`}
          title="Source Control (Ctrl+Shift+G) — click to toggle section"
          aria-label="Source Control"
          aria-pressed={sectionActive("git")}
          onClick={() => switchView("git")}
          disabled={!activeId}
        >
          <Icon name="git-branch" size={20} />
        </button>
        <button
          className={`activity-icon ${sectionActive("tasks") ? "active" : ""}`}
          title="Tasks (npm scripts) — click to toggle section"
          aria-label="Tasks"
          aria-pressed={sectionActive("tasks")}
          onClick={() => switchView("tasks")}
          disabled={!activeId}
        >
          <Icon name="play" size={20} />
        </button>
        <button
          className={`activity-icon ${sectionActive("todos") ? "active" : ""}`}
          title="TODO / FIXME (Ctrl+Shift+T) — click to toggle section"
          aria-label="TODO and FIXME"
          aria-pressed={sectionActive("todos")}
          onClick={() => switchView("todos")}
          disabled={!activeId}
        >
          <Icon name="check-square" size={20} />
        </button>
        <button
          className={`activity-icon ${sectionActive("remote") ? "active" : ""}`}
          title="Remote (SFTP) — click to toggle section. Manage connections in Settings."
          aria-label="Remote SFTP"
          aria-pressed={sectionActive("remote")}
          onClick={() => switchView("remote")}
          disabled={!activeId}
        >
          <Icon name="cloud" size={20} />
        </button>
        <button
          className={`activity-icon ${aiPanelVisible ? "active" : ""}`}
          title="AI Chat (Claude Code · Anthropic · OpenAI · Ollama) — opens on the right"
          aria-label="AI chat panel"
          aria-pressed={aiPanelVisible}
          onClick={() => activeId && setAIPanelVisible(activeId, !aiPanelVisible)}
          disabled={!activeId}
        >
          <AIIcon size={20} />
        </button>
      </div>

      <div className="activity-spacer" />

      {addOpen &&
        addBtnRef.current &&
        (() => {
          const rect = addBtnRef.current.getBoundingClientRect();
          const style: React.CSSProperties = {
            position: "fixed",
            left: rect.right + 6,
            top: rect.top,
            minWidth: 320,
          };
          return createPortal(
            <>
              <div
                className="menu-overlay"
                onClick={() => setAddOpen(false)}
              />
              <div className="menu-dropdown" style={style}>
                <button
                  className="menu-item"
                  onClick={async () => {
                    setAddOpen(false);
                    const sel = await openDialog({
                      directory: true,
                      multiple: false,
                    });
                    if (typeof sel === "string") await openWs(sel);
                  }}
                >
                  <span className="menu-item-label">Open Folder…</span>
                </button>
                {recentNotOpen.length > 0 && (
                  <>
                    <div className="menu-separator" />
                    <div className="menu-section-title">Recent</div>
                    {recentNotOpen.map((w) => (
                      <div key={w.id} className="menu-item-row">
                        <button
                          className="menu-item"
                          onClick={() => {
                            setAddOpen(false);
                            void openWs(w.root);
                          }}
                          title={w.root}
                        >
                          <span className="menu-item-label">{w.name}</span>
                          <span className="menu-item-accel">{w.root}</span>
                        </button>
                        <button
                          className="menu-item-remove"
                          onClick={(e) => {
                            e.stopPropagation();
                            void removeRecent(w.id);
                          }}
                          title="Remove from recent"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </>
                )}
              </div>
            </>,
            document.body,
          );
        })()}
    </div>
  );
}
