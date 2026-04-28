import { useState } from "react";
import { FileTree } from "./FileTree";
import { EditorPane } from "./EditorPane";
import { TerminalPane } from "./TerminalPane";
import { useStore } from "../store";

export function WorkspaceShell() {
  const recent = useStore((s) => s.recent);
  const activeId = useStore((s) => s.activeId);
  const active = recent.find((w) => w.id === activeId);
  const [sidebarW, setSidebarW] = useState(240);
  const [termH, setTermH] = useState(220);

  if (!active) return null;

  return (
    <div className="shell">
      <div className="sidebar" style={{ width: sidebarW }}>
        <div className="sidebar-header">{active.name}</div>
        <FileTree key={active.id} root={active.root} />
      </div>
      <div
        className="vsplit"
        onMouseDown={(e) => {
          e.preventDefault();
          const startX = e.clientX;
          const startW = sidebarW;
          const onMove = (ev: MouseEvent) => {
            setSidebarW(Math.max(140, Math.min(600, startW + ev.clientX - startX)));
          };
          const onUp = () => {
            window.removeEventListener("mousemove", onMove);
            window.removeEventListener("mouseup", onUp);
          };
          window.addEventListener("mousemove", onMove);
          window.addEventListener("mouseup", onUp);
        }}
      />
      <div className="main-col">
        <div className="editor-area">
          <EditorPane />
        </div>
        <div
          className="hsplit"
          onMouseDown={(e) => {
            e.preventDefault();
            const startY = e.clientY;
            const startH = termH;
            const onMove = (ev: MouseEvent) => {
              setTermH(Math.max(80, Math.min(600, startH - (ev.clientY - startY))));
            };
            const onUp = () => {
              window.removeEventListener("mousemove", onMove);
              window.removeEventListener("mouseup", onUp);
            };
            window.addEventListener("mousemove", onMove);
            window.addEventListener("mouseup", onUp);
          }}
        />
        <div className="terminal-area" style={{ height: termH }}>
          <TerminalPane key={active.id} cwd={active.root} />
        </div>
      </div>
    </div>
  );
}
