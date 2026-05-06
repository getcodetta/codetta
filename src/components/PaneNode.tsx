import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import {
  parseKey,
  useStore,
  type DropEdge,
  type Pane,
  type PaneId,
  type WorkspaceData,
} from "../store";
import {
  endDrag,
  getDrag,
  startDrag,
  updateDrag,
  useDrag,
} from "../dragState";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { runCommand } from "../actions";
import { openPalette } from "../paletteBus";
import { prompt as dialogPrompt } from "../dialog";
import { popOutTerminal, redockTerminal } from "../terminalPopout";
import { AIIcon } from "./AIIcon";
import { lookupRemoteLink } from "../sftpLinks";

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const i = norm.lastIndexOf("/");
  return i >= 0 ? norm.slice(i + 1) : norm;
}

function tabLabel(
  ws: WorkspaceData,
  key: string,
): {
  label: string;
  dirty: boolean;
  isTerminal: boolean;
  isAI: boolean;
  popped: boolean;
} {
  const parsed = parseKey(key);
  if (parsed?.kind === "terminal") {
    const t = ws.terminals[parsed.id];
    return {
      label: t?.title ?? "Terminal",
      dirty: false,
      isTerminal: true,
      isAI: false,
      popped: !!t?.popped,
    };
  }
  if (parsed?.kind === "ai") {
    const a = ws.aiChats[parsed.id];
    return {
      label: a?.title ?? "AI Chat",
      dirty: false,
      isTerminal: false,
      isAI: true,
      popped: false,
    };
  }
  if (parsed?.kind === "file") {
    const f = ws.files[parsed.path];
    return {
      label: basename(parsed.path),
      dirty: f ? f.contents !== f.original : false,
      isTerminal: false,
      isAI: false,
      popped: false,
    };
  }
  return {
    label: key,
    dirty: false,
    isTerminal: false,
    isAI: false,
    popped: false,
  };
}

function computeEdgeForPoint(
  el: HTMLElement,
  clientX: number,
  clientY: number,
): DropEdge {
  const rect = el.getBoundingClientRect();
  const x = (clientX - rect.left) / rect.width;
  const y = (clientY - rect.top) / rect.height;
  if (x > 0.25 && x < 0.75 && y > 0.25 && y < 0.75) return "center";
  const dLeft = x;
  const dRight = 1 - x;
  const dTop = y;
  const dBottom = 1 - y;
  const min = Math.min(dLeft, dRight, dTop, dBottom);
  if (min === dLeft) return "left";
  if (min === dRight) return "right";
  if (min === dTop) return "top";
  return "bottom";
}

interface PaneNodeProps {
  wsId: string;
  ws: WorkspaceData;
  pane: Pane;
  registerContainer: (paneId: PaneId, node: HTMLElement | null) => void;
  rightSlotForRoot?: React.ReactNode;
  rootPaneId?: PaneId;
}

export function PaneNode(props: PaneNodeProps) {
  if (props.pane.kind === "split") {
    return <SplitPaneView {...props} pane={props.pane} />;
  }
  return <TabsPaneView {...props} pane={props.pane} />;
}

function SplitPaneView(
  props: PaneNodeProps & { pane: Extract<Pane, { kind: "split" }> },
) {
  const { wsId, ws, pane, registerContainer, rootPaneId } = props;
  const setSplitRatio = useStore((s) => s.setSplitRatio);
  const containerRef = useRef<HTMLDivElement>(null);

  const horizontal = pane.orientation === "horizontal";
  const ratio = pane.ratio;

  return (
    <div
      ref={containerRef}
      className={`split-pane ${horizontal ? "split-h" : "split-v"}`}
    >
      <div
        className="split-child"
        style={
          horizontal
            ? { width: `${ratio * 100}%` }
            : { height: `${ratio * 100}%` }
        }
      >
        <PaneNode
          wsId={wsId}
          ws={ws}
          pane={pane.first}
          registerContainer={registerContainer}
          rootPaneId={rootPaneId}
        />
      </div>
      <div
        className={`split-divider ${horizontal ? "split-divider-h" : "split-divider-v"}`}
        onMouseDown={(e) => {
          e.preventDefault();
          const root = containerRef.current;
          if (!root) return;
          const rect = root.getBoundingClientRect();
          const onMove = (ev: MouseEvent) => {
            const next = horizontal
              ? (ev.clientX - rect.left) / rect.width
              : (ev.clientY - rect.top) / rect.height;
            const clamped = Math.max(0.1, Math.min(0.9, next));
            setSplitRatio(wsId, pane.id, clamped);
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
        className="split-child"
        style={
          horizontal
            ? { width: `${(1 - ratio) * 100}%` }
            : { height: `${(1 - ratio) * 100}%` }
        }
      >
        <PaneNode
          wsId={wsId}
          ws={ws}
          pane={pane.second}
          registerContainer={registerContainer}
          rootPaneId={rootPaneId}
        />
      </div>
    </div>
  );
}

function TabsPaneView(
  props: PaneNodeProps & { pane: Extract<Pane, { kind: "tabs" }> },
) {
  const { wsId, ws, pane, registerContainer, rightSlotForRoot, rootPaneId } =
    props;
  const setActiveTab = useStore((s) => s.setActiveTab);
  const setActivePane = useStore((s) => s.setActivePane);
  const closeTab = useStore((s) => s.closeTab);
  const moveTab = useStore((s) => s.moveTab);

  const isFocused = ws.layout.activePaneId === pane.id;
  const drag = useDrag();
  const setTabPinned = useStore((s) => s.setTabPinned);
  const pinnedSet = new Set(ws.layout.pinned ?? []);
  const orderedTabs = (() => {
    const pinned = pane.tabs.filter((k) => pinnedSet.has(k));
    const rest = pane.tabs.filter((k) => !pinnedSet.has(k));
    return [...pinned, ...rest];
  })();
  const showOverlay = drag?.overPaneId === pane.id && !!drag?.edge;
  const insertLineIndex =
    drag?.overPaneId === pane.id && drag?.tabInsertIndex != null
      ? drag.tabInsertIndex
      : null;
  const tabBarRef = useRef<HTMLDivElement>(null);
  const [tabMenu, setTabMenu] = useState<{ x: number; y: number; key: string } | null>(null);

  const onContentRef = useCallback(
    (node: HTMLDivElement | null) => {
      registerContainer(pane.id, node);
    },
    [pane.id, registerContainer],
  );

  useEffect(() => {
    const id = pane.id;
    return () => {
      registerContainer(id, null);
    };
  }, [pane.id, registerContainer]);

  // Auto-scroll the active tab into view when it changes.
  useEffect(() => {
    if (!pane.active || !tabBarRef.current) return;
    const el = tabBarRef.current.querySelector(
      `[data-tab-key="${CSS.escape(pane.active)}"]`,
    ) as HTMLElement | null;
    el?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [pane.active]);

  const tabMenuItems: (ContextMenuItem | "separator")[] = (() => {
    if (!tabMenu) return [];
    const targetKey = tabMenu.key;
    const others = pane.tabs.filter((x) => x !== targetKey);
    const out: (ContextMenuItem | "separator")[] = [];
    out.push({
      label: "Close",
      onClick: () => closeTab(wsId, targetKey),
    });
    out.push({
      label: "Close Others",
      disabled: others.length === 0,
      onClick: () => {
        for (const k of others) {
          if (!pinnedSet.has(k)) closeTab(wsId, k);
        }
      },
    });
    out.push({
      label: "Close All",
      onClick: () => {
        for (const k of [...pane.tabs]) {
          if (!pinnedSet.has(k)) closeTab(wsId, k);
        }
      },
    });
    const targetIdx = pane.tabs.indexOf(targetKey);
    out.push({
      label: "Close to the Right",
      disabled: targetIdx < 0 || targetIdx >= pane.tabs.length - 1,
      onClick: () => {
        const toClose = pane.tabs.slice(targetIdx + 1);
        for (const k of toClose) closeTab(wsId, k);
      },
    });
    out.push({
      label: "Close to the Left",
      disabled: targetIdx <= 0,
      onClick: () => {
        const toClose = pane.tabs.slice(0, targetIdx);
        for (const k of toClose) closeTab(wsId, k);
      },
    });
    out.push({
      label: "Close Saved",
      onClick: () => {
        for (const k of [...pane.tabs]) {
          const p = parseKey(k);
          if (p?.kind === "file") {
            const f = ws.files[p.path];
            if (f && f.contents === f.original) closeTab(wsId, k);
          }
        }
      },
    });
    out.push("separator");
    out.push({
      label: pinnedSet.has(targetKey) ? "Unpin" : "Pin",
      onClick: () => setTabPinned(wsId, targetKey, !pinnedSet.has(targetKey)),
    });
    const parsed = parseKey(targetKey);
    if (parsed?.kind === "file") {
      out.push("separator");
      out.push({
        label: "Copy Path",
        onClick: async () => {
          try {
            await navigator.clipboard.writeText(parsed.path);
          } catch {
            /* ignore */
          }
        },
      });
    }
    if (parsed?.kind === "ai") {
      const chat = ws.aiChats[parsed.id];
      out.push("separator");
      out.push({
        label: "Rename Chat…",
        disabled: !chat,
        onClick: async () => {
          const next = await dialogPrompt(
            "New chat name",
            chat?.title ?? "",
            { title: "Rename AI chat", okLabel: "Rename" },
          );
          if (!next || !next.trim()) return;
          useStore.getState().setAIChatTitle(wsId, parsed.id, next.trim());
        },
      });
    }
    if (parsed?.kind === "terminal") {
      const term = ws.terminals[parsed.id];
      out.push("separator");
      out.push({
        label: "Rename Terminal…",
        disabled: !term,
        onClick: async () => {
          const next = await dialogPrompt(
            "New terminal name",
            term?.title ?? "",
            { title: "Rename terminal", okLabel: "Rename" },
          );
          if (!next || !next.trim()) return;
          useStore.setState((s) => {
            const w = s.loaded[wsId];
            if (!w || !w.terminals[parsed.id]) return s;
            return {
              loaded: {
                ...s.loaded,
                [wsId]: {
                  ...w,
                  terminals: {
                    ...w.terminals,
                    [parsed.id]: {
                      ...w.terminals[parsed.id],
                      title: next.trim(),
                    },
                  },
                },
              },
            };
          });
        },
      });
      out.push({
        label: "Clear Terminal",
        onClick: () => {
          // Send Ctrl+L to the PTY, which most shells (cmd/pwsh/bash)
          // interpret as "clear screen".
          if (term?.ptyId) {
            void import("../ipc").then(({ pty }) =>
              pty.write(term.ptyId!, "\x0c"),
            );
          }
        },
      });
      out.push("separator");
      if (term?.popped) {
        out.push({
          label: "Re-dock Terminal",
          onClick: () => {
            void redockTerminal(parsed.id);
          },
        });
      } else {
        out.push({
          label: "Pop Out Terminal…",
          disabled: !term,
          onClick: () => {
            if (!term) return;
            void popOutTerminal(wsId, term, ws.meta.root);
          },
        });
      }
    }
    return out;
  })();

  return (
    <div
      className={`tabs-pane ${isFocused ? "focused" : ""}`}
      onMouseDown={() => {
        if (ws.layout.activePaneId !== pane.id) {
          setActivePane(wsId, pane.id);
        }
      }}
    >
      <div
        className="tab-bar"
        data-pane-tab-bar={pane.id}
        ref={tabBarRef}
      >
        {orderedTabs.map((k, idx) => {
          const info = tabLabel(ws, k);
          const isActive = pane.active === k;
          const parsed = parseKey(k);
          const isPinned = pinnedSet.has(k);
          return (
            <Fragment key={k}>
              {insertLineIndex === idx && (
                <div className="tab-insert-line" />
              )}
            <div
              data-tab-index={idx}
              data-tab-key={k}
              className={`tab ${isActive ? "active" : ""} ${isPinned ? "pinned" : ""}`}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                setTabMenu({ x: e.clientX, y: e.clientY, key: k });
              }}
              onPointerDown={(e) => {
                if (e.button !== 0) return;
                const target = e.target as HTMLElement;
                if (target.closest(".tab-close")) return;
                e.preventDefault();
                const startX = e.clientX;
                const startY = e.clientY;
                let dragStarted = false;
                const labelStr = info.label;
                const targetWsId = wsId;
                const targetKey = k;
                const myPaneId = pane.id;

                const onMove = (ev: PointerEvent) => {
                  if (!dragStarted) {
                    const dx = ev.clientX - startX;
                    const dy = ev.clientY - startY;
                    if (dx * dx + dy * dy < 25) return;
                    dragStarted = true;
                    startDrag({
                      wsId: targetWsId,
                      key: targetKey,
                      label: labelStr,
                      x: ev.clientX,
                      y: ev.clientY,
                    });
                  }
                  const el = document.elementFromPoint(
                    ev.clientX,
                    ev.clientY,
                  ) as HTMLElement | null;
                  // Tab-bar insertion mode: drop between existing tabs.
                  const tabBarEl = el?.closest(
                    "[data-pane-tab-bar]",
                  ) as HTMLElement | null;
                  if (tabBarEl) {
                    const overPaneId =
                      tabBarEl.dataset.paneTabBar ?? null;
                    const tabEls = Array.from(
                      tabBarEl.querySelectorAll("[data-tab-index]"),
                    ) as HTMLElement[];
                    let insertIndex = tabEls.length;
                    for (let i = 0; i < tabEls.length; i++) {
                      const r = tabEls[i].getBoundingClientRect();
                      if (ev.clientX < r.left + r.width / 2) {
                        insertIndex = i;
                        break;
                      }
                    }
                    updateDrag(
                      ev.clientX,
                      ev.clientY,
                      overPaneId,
                      null,
                      insertIndex,
                    );
                    return;
                  }
                  // Otherwise fall back to edge-zone detection on pane content.
                  const paneEl = el?.closest("[data-pane-id]") as
                    | HTMLElement
                    | null;
                  const overPaneId = paneEl?.dataset.paneId ?? null;
                  let edge: DropEdge | null = null;
                  if (paneEl) {
                    edge = computeEdgeForPoint(paneEl, ev.clientX, ev.clientY);
                  }
                  updateDrag(ev.clientX, ev.clientY, overPaneId, edge, null);
                };

                const finish = (
                  applyDrop: boolean,
                  upEv?: PointerEvent,
                ) => {
                  document.removeEventListener("pointermove", onMove);
                  document.removeEventListener("pointerup", onUp);
                  document.removeEventListener("pointercancel", onCancel);
                  if (dragStarted) {
                    const cur = getDrag();
                    if (applyDrop && cur?.overPaneId) {
                      if (cur.tabInsertIndex != null) {
                        moveTab(targetWsId, targetKey, {
                          paneId: cur.overPaneId,
                          insertIndex: cur.tabInsertIndex,
                        });
                      } else if (cur.edge) {
                        moveTab(targetWsId, targetKey, {
                          paneId: cur.overPaneId,
                          edge: cur.edge,
                        });
                      }
                    }
                    endDrag();
                  } else if (!isActive && upEv && upEv.button === 0) {
                    setActiveTab(targetWsId, myPaneId, targetKey);
                  }
                };

                const onUp = (ev: PointerEvent) => finish(true, ev);
                const onCancel = () => finish(false);

                document.addEventListener("pointermove", onMove);
                document.addEventListener("pointerup", onUp);
                document.addEventListener("pointercancel", onCancel);
              }}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault();
                  closeTab(wsId, k);
                }
              }}
              title={parsed?.kind === "file" ? parsed.path : info.label}
            >
              <span className="tab-icon">
                {isPinned ? (
                  "📌"
                ) : info.isTerminal ? (
                  "›_"
                ) : info.isAI ? (
                  <AIIcon size={12} />
                ) : (
                  "📄"
                )}
              </span>
              <span className="tab-name">
                {info.label}
                {info.dirty ? " •" : ""}
                {info.popped ? (
                  <span
                    className="tab-popped-mark"
                    title="In a separate window"
                  >
                    {" "}
                    ↗
                  </span>
                ) : null}
                {(() => {
                  // Auto-push indicator: tiny ↥ glyph for files with a
                  // remote link AND autoPush enabled, so the user knows
                  // at a glance which buffers will push to remote on
                  // save. Cheap to compute (localStorage lookup keyed
                  // by absolute path); only runs for file tabs.
                  if (parsed?.kind !== "file") return null;
                  const link = lookupRemoteLink(wsId, parsed.path);
                  if (!link?.autoPush) return null;
                  return (
                    <span
                      className="tab-autopush-mark"
                      title={`Auto-push on save → ${link.remotePath}`}
                    >
                      {" "}
                      ↥
                    </span>
                  );
                })()}
              </span>
              {!isPinned && (
                <button
                  className="tab-close"
                  title="Close"
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    closeTab(wsId, k);
                  }}
                >
                  ×
                </button>
              )}
            </div>
            </Fragment>
          );
        })}
        {insertLineIndex === pane.tabs.length && (
          <div className="tab-insert-line" />
        )}
        <div className="tab-bar-spacer" />
        {rootPaneId === pane.id ? rightSlotForRoot : null}
      </div>
      <div
        ref={onContentRef}
        className="pane-content"
        data-pane-id={pane.id}
      >
        {pane.tabs.length === 0 && <EmptyPane />}
        {showOverlay && drag?.edge && <DropOverlay edge={drag.edge} />}
      </div>
      {tabMenu && (
        <ContextMenu
          x={tabMenu.x}
          y={tabMenu.y}
          items={tabMenuItems}
          onClose={() => setTabMenu(null)}
        />
      )}
    </div>
  );
}

function EmptyPane() {
  return (
    <div className="pane-empty">
      <div className="pane-empty-card">
        <div className="pane-empty-icon">⌘</div>
        <div className="pane-empty-title">Nothing open here</div>
        <div className="pane-empty-actions">
          <button onClick={() => openPalette("")} title="Ctrl+P">
            <span>⌖</span> Quick open file
          </button>
          <button
            onClick={() => openPalette("? ")}
            title="Ctrl+Shift+F"
          >
            <span>🔍</span> Search content
          </button>
          <button
            onClick={() => runCommand("file.open_folder")}
            title="Ctrl+O"
          >
            <span>📂</span> Open folder
          </button>
          <button
            onClick={() => runCommand("terminal.new_bottom")}
            title="Ctrl+`"
          >
            <span>›_</span> New terminal
          </button>
          <button
            onClick={() => runCommand("ai.new_chat")}
            title="Open a new AI chat tab"
          >
            <AIIcon size={14} /> New AI chat
          </button>
        </div>
        <ul className="pane-empty-tips">
          <li>
            <span className="pane-empty-keys">
              <kbd>Ctrl</kbd>
              <kbd>P</kbd>
            </span>
            Jump to a file by name
          </li>
          <li>
            <span className="pane-empty-keys">
              <kbd>Ctrl</kbd>
              <kbd>Shift</kbd>
              <kbd>F</kbd>
            </span>
            Search across the workspace
          </li>
          <li>
            <span className="pane-empty-keys">
              <kbd>Ctrl</kbd>
              <kbd>Tab</kbd>
            </span>
            Cycle recent files
          </li>
          <li>
            <span className="pane-empty-keys">
              <kbd>Ctrl</kbd>
              <kbd>B</kbd>
            </span>
            Toggle the sidebar
          </li>
        </ul>
        <div className="pane-empty-foot">
          Tip: drag any tab onto an edge to split this pane.
        </div>
      </div>
    </div>
  );
}

function DropOverlay({ edge }: { edge: DropEdge }) {
  const style: React.CSSProperties = (() => {
    switch (edge) {
      case "center":
        return { inset: 0 };
      case "left":
        return { top: 0, bottom: 0, left: 0, width: "50%" };
      case "right":
        return { top: 0, bottom: 0, right: 0, width: "50%" };
      case "top":
        return { left: 0, right: 0, top: 0, height: "50%" };
      case "bottom":
        return { left: 0, right: 0, bottom: 0, height: "50%" };
    }
  })();
  return <div className="drop-overlay" style={style} />;
}
