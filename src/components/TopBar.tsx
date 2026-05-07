import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  commandsForCategory,
  confirmDiscardUnsaved,
  type CommandSpec,
} from "../actions";
import { useTheme, type ThemeMode } from "../theme";
import { getActiveEditor } from "../editorState";
import { Icon } from "./Icon";

// Edit-menu actions delegate to the active Monaco editor when one is
// focused (its built-in commands handle the editor's undo stack +
// multi-cursor selections correctly). Falls back to document.execCommand
// for plain inputs/textareas, which still works there even though it's
// deprecated for contentEditable. The previous version called execCommand
// unconditionally, which silently no-op'd inside Monaco.
function runEditAction(
  monacoCmd: string,
  fallback: () => void,
): void {
  const ed = getActiveEditor();
  if (ed && ed.hasTextFocus && ed.hasTextFocus()) {
    try {
      ed.trigger("topbar-menu", monacoCmd, null);
      return;
    } catch {
      /* fall through to fallback below */
    }
  }
  fallback();
}

interface DropdownProps {
  label: string;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  children: React.ReactNode;
}

function MenuButton({ label, open, onToggle, onClose, children }: DropdownProps) {
  return (
    <div className="menu-anchor" data-tauri-drag-region={false}>
      <button
        className={`menu-button ${open ? "open" : ""}`}
        onClick={onToggle}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={`${label} menu`}
      >
        {label}
      </button>
      {open && (
        <>
          <div className="menu-overlay" onClick={onClose} />
          <div className="menu-dropdown" role="menu">
            {children}
          </div>
        </>
      )}
    </div>
  );
}

function MenuItem({
  label,
  accel,
  onClick,
}: {
  label: string;
  accel?: string;
  onClick: () => void;
}) {
  return (
    <button className="menu-item" role="menuitem" onClick={onClick}>
      <span className="menu-item-label">{label}</span>
      {accel && <span className="menu-item-accel">{accel}</span>}
    </button>
  );
}

function MenuSeparator() {
  return <div className="menu-separator" role="separator" />;
}

interface TopBarProps {
  onOpenPalette: () => void;
}

export function TopBar({ onOpenPalette }: TopBarProps) {
  const [menu, setMenu] = useState<string | null>(null);
  const [theme, setTheme] = useTheme();
  const [maximized, setMaximized] = useState(false);

  const closeMenu = () => setMenu(null);
  const toggleMenu = (k: string) => setMenu((cur) => (cur === k ? null : k));

  useEffect(() => {
    let unl: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const win = getCurrentWindow();
        const update = async () => {
          try {
            const m = await win.isMaximized();
            if (!cancelled) setMaximized(m);
          } catch {
            /* ignore */
          }
        };
        await update();
        unl = await win.onResized(() => void update());
      } catch {
        /* ignore */
      }
    })();
    return () => {
      cancelled = true;
      unl?.();
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const onEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeMenu();
    };
    window.addEventListener("keydown", onEsc);
    return () => window.removeEventListener("keydown", onEsc);
  }, [menu]);

  const renderCategoryItems = (cat: CommandSpec["category"]) =>
    commandsForCategory(cat).map((cmd) => (
      <MenuItem
        key={cmd.id}
        label={cmd.label}
        accel={cmd.accel}
        onClick={() => {
          closeMenu();
          void cmd.run();
        }}
      />
    ));

  const themes: {
    mode: ThemeMode;
    label: string;
    icon: "sun" | "moon" | "monitor";
  }[] = [
    { mode: "light", label: "Light", icon: "sun" },
    { mode: "dark", label: "Dark", icon: "moon" },
    { mode: "system", label: "System", icon: "monitor" },
  ];

  const minimize = async () => {
    try {
      await getCurrentWindow().minimize();
    } catch {
      /* ignore */
    }
  };
  const toggleMaximize = async () => {
    try {
      await getCurrentWindow().toggleMaximize();
    } catch {
      /* ignore */
    }
  };
  const closeWindow = async () => {
    // Same dirty-file guard as Ctrl+R: confirm before closing if there's
    // unsaved buffer state. Without this, a click on × silently throws
    // away in-flight edits — the OS-level "save your work?" prompt that
    // every native editor offers wasn't happening because we go straight
    // to Tauri's window.close().
    if (!(await confirmDiscardUnsaved("Close"))) return;
    try {
      await getCurrentWindow().close();
    } catch {
      /* ignore */
    }
  };

  return (
    <div className="topbar" data-tauri-drag-region>
      <div className="topbar-brand" data-tauri-drag-region>
        Codetta
      </div>

      <div className="topbar-menus" data-tauri-drag-region={false}>
        <MenuButton
          label="File"
          open={menu === "file"}
          onToggle={() => toggleMenu("file")}
          onClose={closeMenu}
        >
          {renderCategoryItems("File")}
        </MenuButton>

        <MenuButton
          label="Edit"
          open={menu === "edit"}
          onToggle={() => toggleMenu("edit")}
          onClose={closeMenu}
        >
          <MenuItem
            label="Undo"
            accel="Ctrl+Z"
            onClick={() => {
              closeMenu();
              runEditAction("undo", () => document.execCommand("undo"));
            }}
          />
          <MenuItem
            label="Redo"
            accel="Ctrl+Y"
            onClick={() => {
              closeMenu();
              runEditAction("redo", () => document.execCommand("redo"));
            }}
          />
          <MenuSeparator />
          <MenuItem
            label="Cut"
            accel="Ctrl+X"
            onClick={() => {
              closeMenu();
              // Monaco emits the platform-native cut path via the
              // editor.action.clipboardCutAction id; falls back to
              // execCommand for plain inputs/textareas.
              runEditAction("editor.action.clipboardCutAction", () =>
                document.execCommand("cut"),
              );
            }}
          />
          <MenuItem
            label="Copy"
            accel="Ctrl+C"
            onClick={() => {
              closeMenu();
              runEditAction("editor.action.clipboardCopyAction", () =>
                document.execCommand("copy"),
              );
            }}
          />
          <MenuItem
            label="Paste"
            accel="Ctrl+V"
            onClick={() => {
              closeMenu();
              runEditAction("editor.action.clipboardPasteAction", () =>
                document.execCommand("paste"),
              );
            }}
          />
          <MenuItem
            label="Select All"
            accel="Ctrl+A"
            onClick={() => {
              closeMenu();
              runEditAction("editor.action.selectAll", () =>
                document.execCommand("selectAll"),
              );
            }}
          />
        </MenuButton>

        <MenuButton
          label="View"
          open={menu === "view"}
          onToggle={() => toggleMenu("view")}
          onClose={closeMenu}
        >
          {renderCategoryItems("View")}
          <MenuSeparator />
          <div className="menu-section-title">Theme</div>
          {themes.map((t) => (
            <button
              key={t.mode}
              className="menu-item topbar-theme-item"
              role="menuitem"
              onClick={() => {
                closeMenu();
                setTheme(t.mode);
              }}
            >
              <span className="menu-item-label topbar-theme-label">
                <Icon name={t.icon} size={12} />
                {t.label}
              </span>
              {theme === t.mode && (
                <span className="menu-item-accel">
                  <Icon name="check" size={11} />
                </span>
              )}
            </button>
          ))}
        </MenuButton>

        <MenuButton
          label="Terminal"
          open={menu === "terminal"}
          onToggle={() => toggleMenu("terminal")}
          onClose={closeMenu}
        >
          {renderCategoryItems("Terminal")}
        </MenuButton>

        <MenuButton
          label="Help"
          open={menu === "help"}
          onToggle={() => toggleMenu("help")}
          onClose={closeMenu}
        >
          {renderCategoryItems("Help")}
        </MenuButton>
      </div>

      <div className="topbar-spacer" data-tauri-drag-region />

      <button
        className="topbar-search"
        onClick={onOpenPalette}
        title="Command palette (Ctrl+P)"
        data-tauri-drag-region={false}
      >
        <span className="topbar-search-icon">
          <Icon name="command" size={12} />
        </span>
        <span className="topbar-search-text">
          Search commands & workspaces
        </span>
        <span className="topbar-search-kbd">Ctrl+P</span>
      </button>

      <div className="window-controls" data-tauri-drag-region={false}>
        <button
          className="winctl"
          title="Minimize"
          onClick={() => void minimize()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <rect x="0" y="4.5" width="10" height="1" fill="currentColor" />
          </svg>
        </button>
        <button
          className="winctl"
          title={maximized ? "Restore" : "Maximize"}
          onClick={() => void toggleMaximize()}
        >
          {maximized ? (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect
                x="0.5"
                y="2.5"
                width="7"
                height="7"
                fill="none"
                stroke="currentColor"
              />
              <rect
                x="2.5"
                y="0.5"
                width="7"
                height="7"
                fill="none"
                stroke="currentColor"
              />
            </svg>
          ) : (
            <svg width="10" height="10" viewBox="0 0 10 10">
              <rect
                x="0.5"
                y="0.5"
                width="9"
                height="9"
                fill="none"
                stroke="currentColor"
              />
            </svg>
          )}
        </button>
        <button
          className="winctl winctl-close"
          title="Close"
          onClick={() => void closeWindow()}
        >
          <svg width="10" height="10" viewBox="0 0 10 10">
            <line
              x1="0"
              y1="0"
              x2="10"
              y2="10"
              stroke="currentColor"
              strokeWidth="1.2"
            />
            <line
              x1="10"
              y1="0"
              x2="0"
              y2="10"
              stroke="currentColor"
              strokeWidth="1.2"
            />
          </svg>
        </button>
      </div>
    </div>
  );
}
