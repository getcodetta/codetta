import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useStore } from "./store";
import { startFsBusOnce } from "./fsBus";
import { runCommand } from "./actions";
import { bootstrapTheme } from "./theme";
import { onPaletteOpen, openPalette } from "./paletteBus";
import { basename } from "./pathUtils";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { TopBar } from "./components/TopBar";
import { ActivityBar } from "./components/ActivityBar";
import { CommandPalette } from "./components/CommandPalette";
import { DragGhost } from "./components/DragGhost";
import { StatusBar } from "./components/StatusBar";
import { Toasts } from "./components/Toast";
import { DiffModal } from "./components/DiffModal";
import { Splash } from "./components/Splash";
import { RecentFilesOverlay } from "./components/RecentFilesOverlay";
import { getRecentFiles } from "./recentFiles";
import { useEditorState } from "./editorState";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Dialog } from "./components/Dialog";
import { SettingsModal } from "./components/SettingsModal";
import { TerminalPopoutWindow } from "./components/TerminalPopoutWindow";
import "./App.css";

// When this document was opened as a terminal pop-out window, render only
// the popout shell (no workspace, no toolbars, no store hydration).
const IS_POPOUT = (() => {
  try {
    return new URLSearchParams(window.location.search).get("popout") === "1";
  } catch {
    return false;
  }
})();

function MainApp() {
  const hydrate = useStore((s) => s.hydrate);
  const hydrated = useStore((s) => s.hydrated);
  const openIds = useStore((s) => s.openIds);
  const activeId = useStore((s) => s.activeId);
  const loaded = useStore((s) => s.loaded);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteInitial, setPaletteInitial] = useState("");
  const [recentOverlayOpen, setRecentOverlayOpen] = useState(false);
  const [recentSelected, setRecentSelected] = useState(0);
  const [recentList, setRecentList] = useState<string[]>([]);
  // Min-display latch for the splash. Without this, fast hydrations
  // (warm OS cache, no workspaces to restore) flash the brand for a
  // few frames or skip it entirely. We hold the splash visible until
  // 700 ms after first paint regardless of hydration state.
  const [splashMinElapsed, setSplashMinElapsed] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSplashMinElapsed(true), 700);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    bootstrapTheme();
    startFsBusOnce();
    void hydrate();
  }, [hydrate]);

  // Reflect active workspace + file in the OS window title. Depend only
  // on the active workspace's NAME (not the whole `loaded` map) so the
  // setTitle IPC doesn't fire on every unrelated buffer/layout mutation.
  const editorState = useEditorState();
  const activeWsName = activeId ? loaded[activeId]?.meta.name ?? null : null;
  useEffect(() => {
    const file = editorState.filePath;
    let title = "Codetta";
    if (activeWsName && file) {
      title = `${basename(file)} — ${activeWsName} — Codetta`;
    } else if (activeWsName) {
      title = `${activeWsName} — Codetta`;
    }
    getCurrentWindow()
      .setTitle(title)
      .catch(() => {});
  }, [activeWsName, editorState.filePath]);

  useEffect(() => {
    return onPaletteOpen((initial) => {
      setPaletteInitial(initial);
      setPaletteOpen(true);
    });
  }, []);

  // Pop-out windows announce a redock request via this event (from the
  // popout's Re-dock button OR its own onCloseRequested handler). Main is
  // authoritative: it closes the popout window (popout's self-close is
  // unreliable in some Tauri 2 situations), then flips the popped flag.
  // The window's `tauri://destroyed` listener (registered in popOutTerminal)
  // is the safety net if the close itself races or fails.
  useEffect(() => {
    let off: (() => void) | undefined;
    void listen<{ wsId: string; termId: string }>(
      "popout:redock",
      async (e) => {
        const { wsId, termId } = e.payload;
        const ws = useStore.getState().loaded[wsId];
        if (!ws || !ws.terminals[termId]) return;
        // Force-close the popout from main so we don't depend on the
        // popout's own close() succeeding.
        try {
          const { WebviewWindow } = await import(
            "@tauri-apps/api/webviewWindow"
          );
          const w = await WebviewWindow.getByLabel(`popout-${termId}`);
          if (w) await w.close();
        } catch (err) {
          console.warn("popout close failed", err);
        }
        useStore.getState().setTerminalPopped(wsId, termId, false);
      },
    ).then((u) => {
      off = u;
    });
    return () => {
      off?.();
    };
  }, []);

  // After a Ctrl+R reload, popout windows from the previous session may
  // still be alive. Mark their terminals as popped so the main window
  // doesn't double-mount the xterm against the same PTY.
  useEffect(() => {
    if (!hydrated) return;
    let cancelled = false;
    void (async () => {
      try {
        const { WebviewWindow } = await import(
          "@tauri-apps/api/webviewWindow"
        );
        const all = await WebviewWindow.getAll();
        if (cancelled) return;
        const poppedTermIds = new Set<string>();
        for (const w of all) {
          const m = w.label.match(/^popout-(.+)$/);
          if (m) poppedTermIds.add(m[1]);
        }
        if (poppedTermIds.size === 0) return;
        const state = useStore.getState();
        for (const wsId of state.openIds) {
          const ws = state.loaded[wsId];
          if (!ws) continue;
          for (const termId of Object.keys(ws.terminals)) {
            if (poppedTermIds.has(termId)) {
              state.setTerminalPopped(wsId, termId, true);
            }
          }
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [hydrated]);

  // Start a fs watcher per open workspace. We deliberately depend only on
  // the SHAPE of the open list (ids + their roots), not the full `loaded`
  // map — otherwise every buffer edit / layout tweak re-invokes the watch
  // command for every open ws. The Rust side deduplicates so it's
  // idempotent, but cheap is better than free IPC roundtrips.
  const watchKey = openIds
    .map((id) => `${id}:${loaded[id]?.meta.root ?? ""}`)
    .join("|");
  useEffect(() => {
    for (const id of openIds) {
      const meta = loaded[id]?.meta;
      if (!meta) continue;
      void invoke("fs_watch_start", {
        wsId: id,
        root: meta.root,
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [watchKey]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const ctrl = e.ctrlKey || e.metaKey;
      if (!ctrl) return;
      const k = e.key;
      // Command palette
      if (k === "p" || k === "P") {
        e.preventDefault();
        if (paletteOpen) {
          setPaletteOpen(false);
        } else {
          setPaletteInitial("");
          setPaletteOpen(true);
        }
        return;
      }
      // Map shortcuts to commands
      const lower = k.toLowerCase();
      if (lower === "s" && !e.shiftKey) {
        e.preventDefault();
        runCommand("file.save");
      } else if (lower === "s" && e.shiftKey) {
        e.preventDefault();
        runCommand("file.save_all");
      } else if (lower === "o" && !e.shiftKey) {
        e.preventDefault();
        runCommand("file.open_folder");
      } else if (lower === "o" && e.shiftKey) {
        e.preventDefault();
        runCommand("edit.goto_symbol");
      } else if (lower === "w" && e.shiftKey) {
        e.preventDefault();
        runCommand("file.close_workspace");
      } else if (lower === "b" && !e.shiftKey) {
        e.preventDefault();
        runCommand("view.toggle_sidebar");
      } else if (lower === "j" && !e.shiftKey) {
        e.preventDefault();
        runCommand("view.toggle_panel");
      } else if (lower === "e" && e.shiftKey) {
        e.preventDefault();
        runCommand("view.files");
      } else if (lower === "g" && e.shiftKey) {
        e.preventDefault();
        runCommand("view.source_control");
      } else if (lower === "f" && e.shiftKey) {
        e.preventDefault();
        openPalette("? ");
      } else if (lower === "t" && e.shiftKey) {
        e.preventDefault();
        runCommand("view.todos");
      } else if (lower === "r" && !e.shiftKey) {
        e.preventDefault();
        runCommand("view.reload");
      } else if (k === "`") {
        e.preventDefault();
        runCommand("terminal.new_bottom");
      } else if (lower === "g" && !e.shiftKey) {
        e.preventDefault();
        runCommand("edit.goto_line");
      } else if ((k === "=" || k === "+") && !e.shiftKey) {
        e.preventDefault();
        runCommand("view.zoom_in");
      } else if (k === "-") {
        e.preventDefault();
        runCommand("view.zoom_out");
      } else if (k === "0") {
        e.preventDefault();
        runCommand("view.zoom_reset");
      } else if (lower === "i" && e.shiftKey) {
        e.preventDefault();
        runCommand("edit.format_document");
      } else if (k === ",") {
        e.preventDefault();
        runCommand("view.settings");
      }
    }
    // Alt+Z: word wrap toggle (no Ctrl).
    function onAltKey(e: KeyboardEvent) {
      if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.toLowerCase() === "z") {
        e.preventDefault();
        runCommand("edit.toggle_word_wrap");
      }
    }

    // Ctrl+Tab / Ctrl+Shift+Tab: recent-files cycling overlay.
    // The overlay opens on first press, advances on subsequent presses while
    // Ctrl is held, and commits on Ctrl release.
    function onTabKey(e: KeyboardEvent) {
      if (e.key !== "Tab" || !(e.ctrlKey || e.metaKey)) return;
      const wsId = useStore.getState().activeId;
      if (!wsId) return;
      const list = getRecentFiles(wsId);
      if (list.length < 2) return;
      e.preventDefault();
      setRecentList(list);
      const len = list.length;
      setRecentOverlayOpen((wasOpen) => {
        setRecentSelected((cur) => {
          if (!wasOpen) {
            return e.shiftKey ? len - 1 : 1;
          }
          const delta = e.shiftKey ? -1 : 1;
          return ((cur + delta) % len + len) % len;
        });
        return true;
      });
    }
    function onCtrlUp(e: KeyboardEvent) {
      if (e.key === "Control" || e.key === "Meta") {
        // Use functional update to read latest state without subscribing.
        setRecentOverlayOpen((open) => {
          if (!open) return false;
          // Activate the selected file.
          setRecentSelected((idx) => {
            setRecentList((list) => {
              const wsId = useStore.getState().activeId;
              const path = list[idx];
              if (wsId && path) {
                void useStore.getState().openFile(wsId, path);
              }
              return list;
            });
            return idx;
          });
          return false;
        });
      }
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") {
        setRecentOverlayOpen((open) => (open ? false : open));
      }
    }

    window.addEventListener("keydown", onAltKey);
    window.addEventListener("keydown", onTabKey);
    window.addEventListener("keyup", onCtrlUp);
    window.addEventListener("keydown", onEsc);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onAltKey);
      window.removeEventListener("keydown", onTabKey);
      window.removeEventListener("keyup", onCtrlUp);
      window.removeEventListener("keydown", onEsc);
      window.removeEventListener("keydown", onKey);
    };
  }, [paletteOpen]);

  // Min-display gate so the splash brand doesn't flash for 30 ms
  // when hydration is fast. Holds the splash until BOTH conditions
  // are met: hydrated AND we've been mounted for ~700 ms.
  if (!hydrated || !splashMinElapsed) {
    return <Splash />;
  }

  return (
    <div className="app">
      <TopBar onOpenPalette={() => setPaletteOpen(true)} />
      <div
        className="shell-stack"
        data-sidebar-side={
          activeId ? (loaded[activeId]?.layout.sidebarSide ?? "left") : "left"
        }
      >
        <ActivityBar />
        <div className="workspace-area">
          {openIds.length === 0 ? (
            <WorkspacePicker />
          ) : (
            openIds.map((id) => (
              <WorkspaceShell
                key={id}
                wsId={id}
                isActive={id === activeId}
              />
            ))
          )}
        </div>
      </div>
      <StatusBar onOpenPalette={() => setPaletteOpen(true)} />
      <CommandPalette
        open={paletteOpen}
        initialQuery={paletteInitial}
        onClose={() => setPaletteOpen(false)}
      />
      <DragGhost />
      <Toasts />
      <DiffModal />
      <Dialog />
      <SettingsModal />
      {/* ClaudePermissionOverlay now mounts inline inside AIChatPanel
          so the request appears in the chat next to the agent text
          that triggered it, not as a full-screen modal. */}
      <RecentFilesOverlay
        open={recentOverlayOpen}
        files={recentList}
        selectedIndex={recentSelected}
        workspaceRoot={
          activeId ? loaded[activeId]?.meta.root : undefined
        }
        onSelect={(i) => setRecentSelected(i)}
      />
    </div>
  );
}

export default function App() {
  return IS_POPOUT ? <TerminalPopoutWindow /> : <MainApp />;
}
