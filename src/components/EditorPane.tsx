import Editor from "@monaco-editor/react";
import { useEffect } from "react";
import { useStore } from "../store";

const extToLang: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  js: "javascript",
  jsx: "javascript",
  json: "json",
  md: "markdown",
  rs: "rust",
  py: "python",
  html: "html",
  css: "css",
  scss: "scss",
  go: "go",
  java: "java",
  c: "c",
  cpp: "cpp",
  cs: "csharp",
  yaml: "yaml",
  yml: "yaml",
  toml: "ini",
  sh: "shell",
  ps1: "powershell",
  sql: "sql",
  xml: "xml",
};

function langOf(path: string): string {
  const m = path.toLowerCase().match(/\.([a-z0-9]+)$/);
  return (m && extToLang[m[1]]) || "plaintext";
}

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

export function EditorPane() {
  const tabs = useStore((s) => s.tabs);
  const openTabs = useStore((s) => s.loadedWorkspaceState.openTabs);
  const activeTab = useStore((s) => s.loadedWorkspaceState.activeTab);
  const setActive = useStore((s) => s.setActiveTab);
  const closeTab = useStore((s) => s.closeTab);
  const update = useStore((s) => s.updateTabContents);
  const save = useStore((s) => s.saveTab);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if ((e.ctrlKey || e.metaKey) && e.key === "s") {
        e.preventDefault();
        if (activeTab) void save(activeTab);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [activeTab, save]);

  if (!activeTab || !tabs[activeTab]) {
    return (
      <div className="editor-pane">
        <div className="empty">No file open. Click a file in the tree.</div>
      </div>
    );
  }

  const tab = tabs[activeTab];
  const dirty = tab.contents !== tab.original;

  return (
    <div className="editor-pane">
      <div className="tab-bar">
        {openTabs.map((p) => {
          const t = tabs[p];
          if (!t) return null;
          const isDirty = t.contents !== t.original;
          return (
            <div
              key={p}
              className={`tab ${p === activeTab ? "active" : ""}`}
              onClick={() => setActive(p)}
              title={p}
            >
              <span className="tab-name">
                {basename(p)}
                {isDirty ? " •" : ""}
              </span>
              <button
                className="tab-close"
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(p);
                }}
              >
                ×
              </button>
            </div>
          );
        })}
      </div>
      <div className="editor-host">
        <Editor
          height="100%"
          path={activeTab}
          language={langOf(activeTab)}
          value={tab.contents}
          theme="vs-dark"
          options={{
            fontSize: 13,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            tabSize: 2,
            renderWhitespace: "selection",
          }}
          onChange={(v) => update(activeTab, v ?? "")}
        />
      </div>
      <div className="status-bar">
        <span>{activeTab}</span>
        <span>{dirty ? "Unsaved" : "Saved"}</span>
      </div>
    </div>
  );
}
