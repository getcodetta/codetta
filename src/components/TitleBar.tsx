import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store";

export function TitleBar() {
  const recent = useStore((s) => s.recent);
  const activeId = useStore((s) => s.activeId);
  const switchWs = useStore((s) => s.switchWorkspace);
  const openWs = useStore((s) => s.openWorkspace);
  const [menuOpen, setMenuOpen] = useState(false);

  const active = recent.find((w) => w.id === activeId);

  async function pickFolder() {
    setMenuOpen(false);
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") await openWs(sel);
  }

  return (
    <div className="titlebar">
      <div className="titlebar-brand">Lite Coder Pro</div>
      <div className="titlebar-ws">
        <button
          className="ws-button"
          onClick={() => setMenuOpen((v) => !v)}
          title={active?.root}
        >
          <span className="ws-name">{active?.name ?? "No workspace"}</span>
          <span className="ws-caret">▾</span>
        </button>
        {menuOpen && (
          <>
            <div className="menu-overlay" onClick={() => setMenuOpen(false)} />
            <div className="ws-menu">
              <button className="ws-menu-row" onClick={pickFolder}>
                + Open Folder…
              </button>
              {recent.length > 0 && <div className="ws-menu-sep">Recent</div>}
              {recent.map((w) => (
                <button
                  key={w.id}
                  className={`ws-menu-row ${w.id === activeId ? "active" : ""}`}
                  onClick={() => {
                    setMenuOpen(false);
                    if (w.id !== activeId) void switchWs(w.id);
                  }}
                  title={w.root}
                >
                  <span className="ws-menu-name">{w.name}</span>
                  <span className="ws-menu-path">{w.root}</span>
                </button>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
