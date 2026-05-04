import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { EditorPane } from "./EditorPane";
import { TerminalCore } from "./TerminalCore";
import { PaneNode } from "./PaneNode";
import { SidebarStack } from "./SidebarStack";
import { AIChatPanel } from "./AIChatPanel";
import { AIChatsRail } from "./AIChatsRail";
import { AIIcon } from "./AIIcon";
import {
  aiKey,
  findTabsPaneByTab,
  termKey,
  useStore,
  type PaneId,
  type TerminalLocation,
} from "../store";
import { pty, type ShellOption } from "../ipc";
import { redockTerminal } from "../terminalPopout";

interface Props {
  wsId: string;
  isActive: boolean;
}

interface ShellDropdownProps {
  anchor: HTMLElement | null;
  shells: ShellOption[];
  onClose: () => void;
  onPick: (shell?: ShellOption) => void;
}

function ShellDropdown({ anchor, shells, onClose, onPick }: ShellDropdownProps) {
  if (!anchor) return null;
  const rect = anchor.getBoundingClientRect();
  const style: React.CSSProperties = {
    position: "fixed",
    top: rect.bottom + 2,
    right: Math.max(8, window.innerWidth - rect.right),
    left: "auto",
  };
  return createPortal(
    <>
      <div className="menu-overlay" onClick={onClose} />
      <div className="menu-dropdown shell-dropdown" style={style}>
        <button className="menu-item" onClick={() => onPick()}>
          <span className="menu-item-label">Default shell</span>
        </button>
        {shells.length > 0 && <div className="menu-separator" />}
        {shells.map((sh) => (
          <button
            key={sh.id}
            className="menu-item"
            onClick={() => onPick(sh)}
            title={sh.path}
          >
            <span className="menu-item-label">{sh.label}</span>
            <span className="menu-item-accel">{sh.id}</span>
          </button>
        ))}
      </div>
    </>,
    document.body,
  );
}

export function WorkspaceShell({ wsId, isActive }: Props) {
  const ws = useStore((s) => s.loaded[wsId]);
  const setTermH = useStore((s) => s.setTermH);
  const setBottomVisible = useStore((s) => s.setBottomVisible);
  const addTerminal = useStore((s) => s.addTerminal);
  const setAIPanelW = useStore((s) => s.setAIPanelW);
  const setAIPanelVisible = useStore((s) => s.setAIPanelVisible);

  const [paneContainers, setPaneContainers] = useState<
    Record<PaneId, HTMLElement>
  >({});
  const [shells, setShells] = useState<ShellOption[]>([]);
  const [addOpen, setAddOpen] = useState<"bottom" | null>(null);
  const bottomAddBtnRef = useRef<HTMLButtonElement>(null);

  const registerContainer = useCallback(
    (paneId: PaneId, node: HTMLElement | null) => {
      setPaneContainers((prev) => {
        const cur = prev[paneId];
        if (node === cur) return prev;
        if (!node) {
          if (!(paneId in prev)) return prev;
          const { [paneId]: _drop, ...rest } = prev;
          return rest;
        }
        return { ...prev, [paneId]: node };
      });
    },
    [],
  );

  useEffect(() => {
    let alive = true;
    pty
      .availableShells()
      .then((s) => {
        if (alive) setShells(s);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  const spawnTerminal = (location: TerminalLocation, shell?: ShellOption) => {
    setAddOpen(null);
    addTerminal(
      wsId,
      location,
      shell
        ? { path: shell.path, args: shell.args, label: shell.label }
        : undefined,
    );
  };

  const autoCreatedRef = useRef(false);
  useEffect(() => {
    if (!ws || autoCreatedRef.current) return;
    autoCreatedRef.current = true;
    if (Object.keys(ws.terminals).length === 0) {
      addTerminal(wsId, "bottom");
    }
  }, [ws, wsId, addTerminal]);

  if (!ws) return null;
  const layout = ws.layout;

  return (
    <div
      className="shell"
      style={{ display: isActive ? "flex" : "none" }}
      data-ws-id={wsId}
      data-sidebar-side={layout.sidebarSide}
    >
      {layout.sidebarVisible && <SidebarStack wsId={wsId} ws={ws} />}
      <AIChatsRail wsId={wsId} ws={ws} />
      {layout.aiPanelVisible && (
        <>
          <div
            className="vsplit ai-vsplit"
            onMouseDown={(e) => {
              e.preventDefault();
              const startX = e.clientX;
              const startW = layout.aiPanelW;
              const onMove = (ev: MouseEvent) => {
                setAIPanelW(wsId, startW - (ev.clientX - startX));
              };
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
          />
          <div
            className="ai-side-panel"
            style={{ width: layout.aiPanelW }}
          >
            <div className="ai-side-panel-header">
              <span className="ai-side-panel-title">
                <AIIcon size={14} /> AI Chat
              </span>
              <button
                className="ai-side-panel-close"
                onClick={() => setAIPanelVisible(wsId, false)}
                title="Hide AI panel"
              >
                ×
              </button>
            </div>
            <div className="ai-side-panel-body">
              <AIChatPanel wsId={wsId} root={ws.meta.root} />
            </div>
          </div>
        </>
      )}
      <div className="main-col">
        <div className="editor-area">
          <PaneNode
            wsId={wsId}
            ws={ws}
            pane={layout.editorRoot}
            registerContainer={registerContainer}
            rootPaneId={layout.editorRoot.id}
            rightSlotForRoot={
              <button
                className="tab-add tab-add-ai"
                title="New AI chat tab — drag the tab edge to split"
                onClick={() => useStore.getState().addAIChat(wsId, "editor")}
              >
                <AIIcon size={12} /> New AI
              </button>
            }
          />
        </div>
        {/*
          Bottom panel: kept mounted (just visually hidden via display:none)
          when bottomVisible is false. Unmounting + remounting it would
          tear down the pane container DOM nodes that TerminalCore
          portals into — and re-opening an xterm Terminal on a new DOM
          node is fragile (silent loss of buffer + listeners). Keeping
          the panel in the DOM means the same container ref stays valid
          across hide/show, so terminals just disappear/reappear without
          losing state. Pay-cost: a sliver of layout space; worth it.
        */}
        {layout.bottomRoot && (
          <>
            {layout.bottomVisible && (
              <div
                className="hsplit"
                onMouseDown={(e) => {
                  e.preventDefault();
                  const startY = e.clientY;
                  const startH = layout.termH;
                  const onMove = (ev: MouseEvent) => {
                    setTermH(
                      wsId,
                      Math.max(80, Math.min(800, startH - (ev.clientY - startY))),
                    );
                  };
                  const onUp = () => {
                    window.removeEventListener("mousemove", onMove);
                    window.removeEventListener("mouseup", onUp);
                  };
                  window.addEventListener("mousemove", onMove);
                  window.addEventListener("mouseup", onUp);
                }}
              />
            )}
            <div
              className="bottom-area"
              style={{
                height: layout.termH,
                display: layout.bottomVisible ? undefined : "none",
              }}
            >
              <PaneNode
                wsId={wsId}
                ws={ws}
                pane={layout.bottomRoot}
                registerContainer={registerContainer}
                rootPaneId={layout.bottomRoot.id}
                rightSlotForRoot={
                  <>
                    <button
                      ref={bottomAddBtnRef}
                      className="tab-add"
                      title="New terminal"
                      onClick={() =>
                        setAddOpen(addOpen === "bottom" ? null : "bottom")
                      }
                    >
                      + Term ▾
                    </button>
                    <button
                      className="tab-add tab-add-ai"
                      title="New AI chat tab"
                      onClick={() =>
                        useStore.getState().addAIChat(wsId, "bottom")
                      }
                    >
                      <AIIcon size={12} /> New AI
                    </button>
                    <button
                      className="tab-add"
                      title="Hide panel"
                      onClick={() => setBottomVisible(wsId, false)}
                    >
                      ▾
                    </button>
                  </>
                }
              />
            </div>
          </>
        )}
        {(!layout.bottomVisible || !layout.bottomRoot) && (
          <button
            className="show-bottom"
            onClick={() => {
              setBottomVisible(wsId, true);
              if (!layout.bottomRoot) addTerminal(wsId, "bottom");
            }}
            title="Show panel"
          >
            ▴ Panel
          </button>
        )}
      </div>

      {addOpen === "bottom" && (
        <ShellDropdown
          anchor={bottomAddBtnRef.current}
          shells={shells}
          onClose={() => setAddOpen(null)}
          onPick={(sh) => spawnTerminal("bottom", sh)}
        />
      )}

      {/* File editors: one per pane that has an active file tab. */}
      {(() => {
        const overlays: React.ReactNode[] = [];
        const visit = (pane: typeof layout.editorRoot) => {
          if (pane.kind === "tabs") {
            const active = pane.active;
            if (active && active.startsWith("file:")) {
              const path = active.slice(5);
              const container = paneContainers[pane.id];
              if (container && ws.files[path]) {
                overlays.push(
                  createPortal(
                    <EditorPane
                      key={pane.id + ":" + path}
                      wsId={wsId}
                      path={path}
                    />,
                    container,
                    pane.id + ":" + path,
                  ),
                );
              }
            }
          } else {
            visit(pane.first);
            visit(pane.second);
          }
        };
        visit(layout.editorRoot);
        if (layout.bottomRoot && layout.bottomVisible) {
          visit(layout.bottomRoot);
        }
        return <>{overlays}</>;
      })()}

      {/* AI chats: one AIChatHost per descriptor. Internally portals an
          AIChatPanel into the pane container that currently owns the
          tab. Because the React component itself stays mounted across
          container changes, in-flight streams + chat state survive a
          tab being dragged from one pane to another. */}
      {Object.values(ws.aiChats).map((chat) => {
        const tabKeyStr = aiKey(chat.id);
        const editorPane = findTabsPaneByTab(layout.editorRoot, tabKeyStr);
        const bottomPane = layout.bottomRoot
          ? findTabsPaneByTab(layout.bottomRoot, tabKeyStr)
          : null;
        const pane = editorPane ?? bottomPane;
        const inBottom = !editorPane && !!bottomPane;
        const container = pane ? (paneContainers[pane.id] ?? null) : null;
        const visible =
          isActive &&
          !!pane &&
          pane.active === tabKeyStr &&
          (inBottom ? layout.bottomVisible : true);
        return (
          <AIChatHost
            key={chat.id}
            wsId={wsId}
            root={ws.meta.root}
            chatId={chat.id}
            container={container}
            visible={visible}
          />
        );
      })}

      {/* Terminals: one TerminalCore per terminal, portal-ed to its current pane's container. */}
      {Object.values(ws.terminals).map((t) => {
        const tabKeyStr = termKey(t.id);
        const editorPane = findTabsPaneByTab(layout.editorRoot, tabKeyStr);
        const bottomPane = layout.bottomRoot
          ? findTabsPaneByTab(layout.bottomRoot, tabKeyStr)
          : null;
        const pane = editorPane ?? bottomPane;
        const inBottom = !editorPane && !!bottomPane;
        const container = pane ? (paneContainers[pane.id] ?? null) : null;
        const visible =
          isActive &&
          !!pane &&
          pane.active === tabKeyStr &&
          (inBottom ? layout.bottomVisible : true);
        // While popped out, hide the in-window xterm and render a placeholder
        // in its slot. The popout window owns the only live xterm bound to
        // this PTY; on re-dock the terminal is re-mounted and replays the
        // backend's scrollback.
        if (t.popped) {
          return (
            <PoppedPlaceholder
              key={t.id}
              container={container}
              visible={visible}
              title={t.title}
              onRedock={() => {
                void redockTerminal(t.id);
              }}
            />
          );
        }
        return (
          <TerminalCore
            key={t.id}
            termId={t.id}
            cwd={ws.meta.root}
            container={container}
            visible={visible}
            shellPath={t.shell?.path}
            shellArgs={t.shell?.args}
            title={t.title}
            ptyId={t.ptyId}
            onPtyIdChange={(id) =>
              useStore.getState().setTerminalPtyId(wsId, t.id, id)
            }
          />
        );
      })}
    </div>
  );
}

interface AIChatHostProps {
  wsId: string;
  root: string;
  chatId: string;
  container: HTMLElement | null;
  visible: boolean;
}

function AIChatHost({
  wsId,
  root,
  chatId,
  container,
  visible,
}: AIChatHostProps) {
  if (!container) return null;
  return createPortal(
    <div
      className="ai-tab-host"
      style={{ display: visible ? "flex" : "none" }}
    >
      <AIChatPanel wsId={wsId} root={root} aiChatId={chatId} />
    </div>,
    container,
  );
}

interface PoppedPlaceholderProps {
  container: HTMLElement | null;
  visible: boolean;
  title: string;
  onRedock: () => void;
}

function PoppedPlaceholder({
  container,
  visible,
  title,
  onRedock,
}: PoppedPlaceholderProps) {
  if (!container) return null;
  return createPortal(
    <div
      className="popped-placeholder"
      style={{ display: visible ? "flex" : "none" }}
    >
      <div className="popped-placeholder-card">
        <div className="popped-placeholder-icon">⤴</div>
        <div className="popped-placeholder-title">
          {title} is in a separate window
        </div>
        <div className="popped-placeholder-hint">
          Closing the pop-out window or clicking re-dock brings it back here.
        </div>
        <button className="popped-placeholder-btn" onClick={onRedock}>
          ↩ Re-dock now
        </button>
      </div>
    </div>,
    container,
  );
}

