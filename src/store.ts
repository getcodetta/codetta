import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import {
  workspaces as wsApi,
  type WorkspaceMeta,
  fs as fsApi,
  pty as ptyApi,
} from "./ipc";
import { confirm as dialogConfirm } from "./dialog";
import { getEditorSettings } from "./editorSettings";

export type TerminalLocation = "editor" | "bottom";

export interface TerminalShell {
  path: string;
  args: string[];
  label: string;
}

export interface TerminalDescriptor {
  id: string;
  title: string;
  shell?: TerminalShell;
  /**
   * Backend PTY session id. Set after pty.spawn returns, persisted to disk.
   * On reload we filter the descriptors against `pty.listSessions()` and
   * re-attach to any whose ptyId is still alive — the user keeps their
   * running shell across hot-reload / Ctrl+R.
   */
  ptyId?: string;
}

export interface FileData {
  contents: string;
  original: string;
}

export type SidebarView = "files" | "git" | "tasks" | "todos" | "ai";

export interface SidebarSection {
  view: SidebarView;
  collapsed: boolean;
  /** Relative size (flex-grow) when uncollapsed. Default 1. */
  size: number;
}

export type DropEdge = "center" | "top" | "bottom" | "left" | "right";

export type PaneId = string;

export interface TabsPane {
  kind: "tabs";
  id: PaneId;
  tabs: string[];
  active: string | null;
}

export interface SplitPane {
  kind: "split";
  id: PaneId;
  orientation: "horizontal" | "vertical";
  ratio: number;
  first: Pane;
  second: Pane;
}

export type Pane = TabsPane | SplitPane;

export interface WorkspaceLayout {
  editorRoot: Pane;
  bottomRoot: Pane | null;
  activePaneId: PaneId | null;
  bottomVisible: boolean;
  sidebarVisible: boolean;
  expandedDirs: string[];
  sidebarW: number;
  termH: number;
  sidebarView: SidebarView;
  /** Tab keys pinned across the workspace; render first and skip bulk-close. */
  pinned: string[];
  /** Stacked sidebar sections in render order. */
  sidebarSections: SidebarSection[];
  /** Whether the sidebar+activity bar sit on the left or right of the editor. */
  sidebarSide: "left" | "right";
  /** AI panel is a dedicated right-side column, independent of sidebarSide. */
  aiPanelVisible: boolean;
  aiPanelW: number;
}

export interface WorkspaceData {
  meta: WorkspaceMeta;
  layout: WorkspaceLayout;
  files: Record<string, FileData>;
  terminals: Record<string, TerminalDescriptor>;
}

export const fileKey = (p: string) => "file:" + p;
export const termKey = (id: string) => "term:" + id;
export function parseKey(
  k: string,
):
  | { kind: "file"; path: string }
  | { kind: "terminal"; id: string }
  | null {
  if (k.startsWith("file:")) return { kind: "file", path: k.slice(5) };
  if (k.startsWith("term:")) return { kind: "terminal", id: k.slice(5) };
  return null;
}

// -------- Pane tree helpers --------

function makePaneId(): string {
  return "p_" + Math.random().toString(36).slice(2, 10);
}

function emptyTabsPane(): TabsPane {
  return { kind: "tabs", id: makePaneId(), tabs: [], active: null };
}

export function findTabsPaneByTab(p: Pane, key: string): TabsPane | null {
  if (p.kind === "tabs") {
    return p.tabs.includes(key) ? p : null;
  }
  return findTabsPaneByTab(p.first, key) ?? findTabsPaneByTab(p.second, key);
}

export function findPaneById(p: Pane, id: PaneId): Pane | null {
  if (p.id === id) return p;
  if (p.kind === "split") {
    return findPaneById(p.first, id) ?? findPaneById(p.second, id);
  }
  return null;
}

export function isInTree(p: Pane, paneId: PaneId): boolean {
  return findPaneById(p, paneId) !== null;
}

export function firstLeaf(p: Pane): TabsPane {
  let cur: Pane = p;
  while (cur.kind === "split") cur = cur.first;
  return cur;
}

function mapTree(p: Pane, fn: (t: TabsPane) => TabsPane): Pane {
  if (p.kind === "tabs") return fn(p);
  return {
    ...p,
    first: mapTree(p.first, fn),
    second: mapTree(p.second, fn),
  };
}

function replacePaneById(root: Pane, id: PaneId, replacement: Pane): Pane {
  if (root.id === id) return replacement;
  if (root.kind === "tabs") return root;
  return {
    ...root,
    first: replacePaneById(root.first, id, replacement),
    second: replacePaneById(root.second, id, replacement),
  };
}

function removeTabFromTree(
  root: Pane,
  key: string,
): { tree: Pane | null; removedFromPaneId: PaneId | null } {
  if (root.kind === "tabs") {
    if (!root.tabs.includes(key))
      return { tree: root, removedFromPaneId: null };
    const tabs = root.tabs.filter((t) => t !== key);
    if (tabs.length === 0) {
      return { tree: null, removedFromPaneId: root.id };
    }
    let active = root.active;
    if (active === key) {
      const idx = root.tabs.indexOf(key);
      active = tabs[Math.max(0, idx - 1)] ?? tabs[0] ?? null;
    }
    return {
      tree: { ...root, tabs, active },
      removedFromPaneId: root.id,
    };
  }
  const leftRes = removeTabFromTree(root.first, key);
  if (leftRes.removedFromPaneId) {
    if (!leftRes.tree) {
      // First child collapsed; replace this split with second child.
      return { tree: root.second, removedFromPaneId: leftRes.removedFromPaneId };
    }
    return {
      tree: { ...root, first: leftRes.tree },
      removedFromPaneId: leftRes.removedFromPaneId,
    };
  }
  const rightRes = removeTabFromTree(root.second, key);
  if (rightRes.removedFromPaneId) {
    if (!rightRes.tree) {
      return { tree: root.first, removedFromPaneId: rightRes.removedFromPaneId };
    }
    return {
      tree: { ...root, second: rightRes.tree },
      removedFromPaneId: rightRes.removedFromPaneId,
    };
  }
  return { tree: root, removedFromPaneId: null };
}

function pruneEmptyTabsPanes(p: Pane | null): Pane | null {
  if (!p) return null;
  if (p.kind === "tabs") return p.tabs.length === 0 ? null : p;
  const first = pruneEmptyTabsPanes(p.first);
  const second = pruneEmptyTabsPanes(p.second);
  if (!first && !second) return null;
  if (!first) return second!;
  if (!second) return first;
  return { ...p, first, second };
}

export function dropTabAt(
  root: Pane,
  targetPaneId: PaneId,
  edge: DropEdge,
  key: string,
): { tree: Pane; activePaneId: PaneId } {
  const { tree: cleaned } = removeTabFromTree(root, key);
  const cleanedRoot: Pane = cleaned ?? emptyTabsPane();

  let target = findPaneById(cleanedRoot, targetPaneId);
  // After cleanup the target may have collapsed; fall back to first leaf.
  if (!target) {
    const leaf = firstLeaf(cleanedRoot);
    const updated = mapTree(cleanedRoot, (t) =>
      t.id === leaf.id
        ? {
            ...t,
            tabs: t.tabs.includes(key) ? t.tabs : [...t.tabs, key],
            active: key,
          }
        : t,
    );
    return { tree: updated, activePaneId: leaf.id };
  }

  if (edge === "center" || target.kind !== "tabs") {
    // Add to target's tabs (if it's a leaf). If target is a split, add to its first leaf.
    if (target.kind === "split") {
      const leaf = firstLeaf(target);
      target = leaf;
    }
    const targetId = target.id;
    const updated = mapTree(cleanedRoot, (t) =>
      t.id === targetId
        ? {
            ...t,
            tabs: t.tabs.includes(key) ? t.tabs : [...t.tabs, key],
            active: key,
          }
        : t,
    );
    return { tree: updated, activePaneId: targetId };
  }

  const newPane: TabsPane = {
    kind: "tabs",
    id: makePaneId(),
    tabs: [key],
    active: key,
  };
  const orientation: SplitPane["orientation"] =
    edge === "left" || edge === "right" ? "horizontal" : "vertical";
  const split: SplitPane = {
    kind: "split",
    id: makePaneId(),
    orientation,
    ratio: 0.5,
    first: edge === "left" || edge === "top" ? newPane : target,
    second: edge === "left" || edge === "top" ? target : newPane,
  };
  const tree = replacePaneById(cleanedRoot, target.id, split);
  return { tree, activePaneId: newPane.id };
}

export function setActiveInPane(
  root: Pane,
  paneId: PaneId,
  key: string | null,
): Pane {
  return mapTree(root, (t) => (t.id === paneId ? { ...t, active: key } : t));
}

// Insert a tab at a specific position inside a leaf pane. The visualIndex
// is computed from the *current* tab list (including the dragged tab if it
// already lives in this pane), so we adjust by -1 if the dragged tab is
// being moved past its own current position.
export function dropTabAtIndex(
  root: Pane,
  targetPaneId: PaneId,
  visualIndex: number,
  key: string,
): { tree: Pane; activePaneId: PaneId } {
  const targetPane = findPaneById(root, targetPaneId);
  let effectiveIdx = visualIndex;
  if (targetPane && targetPane.kind === "tabs") {
    const sourceIdx = targetPane.tabs.indexOf(key);
    if (sourceIdx >= 0 && visualIndex > sourceIdx) {
      effectiveIdx = visualIndex - 1;
    }
  }

  const { tree: cleaned } = removeTabFromTree(root, key);
  let cleanedRoot: Pane = cleaned ?? emptyTabsPane();

  const newTarget = findPaneById(cleanedRoot, targetPaneId);
  if (!newTarget || newTarget.kind !== "tabs") {
    const leaf = firstLeaf(cleanedRoot);
    cleanedRoot = mapTree(cleanedRoot, (t) =>
      t.id === leaf.id
        ? {
            ...t,
            tabs: t.tabs.includes(key) ? t.tabs : [...t.tabs, key],
            active: key,
          }
        : t,
    );
    return { tree: cleanedRoot, activePaneId: leaf.id };
  }

  cleanedRoot = mapTree(cleanedRoot, (t) => {
    if (t.id !== targetPaneId) return t;
    const tabs = [...t.tabs];
    const clamped = Math.max(0, Math.min(effectiveIdx, tabs.length));
    tabs.splice(clamped, 0, key);
    return { ...t, tabs, active: key };
  });
  return { tree: cleanedRoot, activePaneId: targetPaneId };
}

function setSplitRatioInTree(
  root: Pane,
  splitId: PaneId,
  ratio: number,
): Pane {
  if (root.id === splitId && root.kind === "split") {
    return { ...root, ratio };
  }
  if (root.kind === "split") {
    return {
      ...root,
      first: setSplitRatioInTree(root.first, splitId, ratio),
      second: setSplitRatioInTree(root.second, splitId, ratio),
    };
  }
  return root;
}

// Determine whether a pane id sits inside the bottomRoot.
export function isInBottom(layout: WorkspaceLayout, paneId: PaneId): boolean {
  return layout.bottomRoot ? isInTree(layout.bottomRoot, paneId) : false;
}

// -------- Store --------

export interface HydrateProgress {
  phase: string;
  current: number;
  total: number;
}

interface AppState {
  recent: WorkspaceMeta[];
  openIds: string[];
  activeId: string | null;
  loaded: Record<string, WorkspaceData>;
  hydrated: boolean;
  hydrateProgress: HydrateProgress;

  hydrate(): Promise<void>;
  openWorkspace(root: string): Promise<void>;
  closeWorkspace(id: string): Promise<void>;
  removeFromRecent(id: string): Promise<void>;
  setActiveWorkspace(id: string): Promise<void>;

  openFile(wsId: string, path: string): Promise<void>;
  closeTab(wsId: string, key: string): Promise<void>;
  setActiveTab(wsId: string, paneId: PaneId, key: string): void;
  setActivePane(wsId: string, paneId: PaneId): void;
  setTabPinned(wsId: string, key: string, pinned: boolean): void;
  moveTab(
    wsId: string,
    key: string,
    target:
      | { paneId: PaneId; edge: DropEdge }
      | { paneId: PaneId; insertIndex: number },
  ): void;
  setSplitRatio(wsId: string, splitId: PaneId, ratio: number): void;
  updateFileContents(wsId: string, path: string, contents: string): void;
  saveFile(wsId: string, path: string): Promise<void>;
  saveAllFiles(wsId: string): Promise<void>;

  toggleDir(wsId: string, path: string): void;
  setSidebarW(wsId: string, w: number): void;
  setTermH(wsId: string, h: number): void;
  setBottomVisible(wsId: string, v: boolean): void;
  setSidebarVisible(wsId: string, v: boolean): void;
  setSidebarView(wsId: string, v: SidebarView): void;
  toggleSidebarSection(wsId: string, view: SidebarView): void;
  removeSidebarSection(wsId: string, view: SidebarView): void;
  collapseSidebarSection(wsId: string, view: SidebarView, collapsed: boolean): void;
  setSidebarSectionSize(wsId: string, view: SidebarView, size: number): void;
  reorderSidebarSection(
    wsId: string,
    view: SidebarView,
    beforeView: SidebarView | null,
  ): void;
  setSidebarSide(wsId: string, side: "left" | "right"): void;
  setAIPanelVisible(wsId: string, visible: boolean): void;
  setAIPanelW(wsId: string, w: number): void;

  addTerminal(
    wsId: string,
    location?: TerminalLocation,
    shell?: TerminalShell,
  ): string;
  closeTerminal(wsId: string, id: string): void;
  setTerminalPtyId(wsId: string, termId: string, ptyId: string): void;
}

const defaultLayout = (): WorkspaceLayout => {
  const editorRoot = emptyTabsPane();
  return {
    editorRoot,
    bottomRoot: null,
    activePaneId: editorRoot.id,
    bottomVisible: true,
    sidebarVisible: true,
    expandedDirs: [],
    sidebarW: 240,
    termH: 240,
    sidebarView: "files",
    pinned: [],
    sidebarSections: [{ view: "files", collapsed: false, size: 1 }],
    sidebarSide: "left",
    aiPanelVisible: false,
    aiPanelW: 380,
  };
};

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function makeWsId(root: string): string {
  let h = 0;
  for (let i = 0; i < root.length; i++) h = (h * 31 + root.charCodeAt(i)) | 0;
  return `ws_${Math.abs(h).toString(36)}_${root.length.toString(36)}`;
}

function makeTermId(): string {
  return "t_" + Math.random().toString(36).slice(2, 10);
}

function sanitizePane(p: unknown): Pane {
  if (!p || typeof p !== "object") return emptyTabsPane();
  const o = p as Record<string, unknown>;
  if (o.kind === "split") {
    return {
      kind: "split",
      id: typeof o.id === "string" ? o.id : makePaneId(),
      orientation: o.orientation === "vertical" ? "vertical" : "horizontal",
      ratio:
        typeof o.ratio === "number"
          ? Math.max(0.1, Math.min(0.9, o.ratio))
          : 0.5,
      first: sanitizePane(o.first),
      second: sanitizePane(o.second),
    };
  }
  return {
    kind: "tabs",
    id: typeof o.id === "string" ? o.id : makePaneId(),
    tabs: Array.isArray(o.tabs) ? (o.tabs as string[]) : [],
    active: typeof o.active === "string" ? (o.active as string) : null,
  };
}

function normalizeLayout(raw: unknown): WorkspaceLayout {
  if (!raw || typeof raw !== "object") return defaultLayout();
  const r = raw as Record<string, unknown>;

  // Old-shape migration (editorOrder / bottomOrder / openTabs).
  if (
    Array.isArray(r.editorOrder) ||
    Array.isArray(r.openTabs) ||
    Array.isArray(r.bottomOrder)
  ) {
    const editorTabs: string[] = Array.isArray(r.editorOrder)
      ? (r.editorOrder as string[])
      : Array.isArray(r.openTabs)
        ? (r.openTabs as string[]).map((p) => fileKey(p))
        : [];
    const editorActiveOld =
      typeof r.editorActive === "string"
        ? (r.editorActive as string)
        : typeof r.activeTab === "string"
          ? fileKey(r.activeTab as string)
          : null;
    const editorPane: TabsPane = {
      kind: "tabs",
      id: makePaneId(),
      tabs: editorTabs,
      active:
        editorActiveOld && editorTabs.includes(editorActiveOld)
          ? editorActiveOld
          : (editorTabs[editorTabs.length - 1] ?? null),
    };
    const bottomTabs: string[] = Array.isArray(r.bottomOrder)
      ? (r.bottomOrder as string[])
      : [];
    let bottomRoot: Pane | null = null;
    if (bottomTabs.length > 0) {
      const bottomActiveOld =
        typeof r.bottomActive === "string" ? (r.bottomActive as string) : null;
      bottomRoot = {
        kind: "tabs",
        id: makePaneId(),
        tabs: bottomTabs,
        active:
          bottomActiveOld && bottomTabs.includes(bottomActiveOld)
            ? bottomActiveOld
            : (bottomTabs[bottomTabs.length - 1] ?? null),
      };
    }
    return {
      editorRoot: editorPane,
      bottomRoot,
      activePaneId: editorPane.id,
      bottomVisible:
        typeof r.bottomVisible === "boolean" ? r.bottomVisible : true,
      sidebarVisible:
        typeof r.sidebarVisible === "boolean" ? r.sidebarVisible : true,
      expandedDirs: Array.isArray(r.expandedDirs)
        ? (r.expandedDirs as string[])
        : [],
      sidebarW: typeof r.sidebarW === "number" ? r.sidebarW : 240,
      termH: typeof r.termH === "number" ? r.termH : 240,
      sidebarView: (["files","git","tasks","todos","ai"] as SidebarView[]).includes(r.sidebarView as SidebarView) ? (r.sidebarView as SidebarView) : "files",
      pinned: Array.isArray((r as any).pinned) ? (r as any).pinned.filter((x: unknown) => typeof x === "string") : [],
      sidebarSections: parseSidebarSections((r as any).sidebarSections, (r.sidebarView as SidebarView) ?? "files"),
      sidebarSide: (r as any).sidebarSide === "right" ? "right" : "left",
      aiPanelVisible: (r as any).aiPanelVisible === true,
      aiPanelW:
        typeof (r as any).aiPanelW === "number"
          ? Math.max(220, Math.min(800, (r as any).aiPanelW))
          : 380,
    };
  }

  const editorRoot = r.editorRoot ? sanitizePane(r.editorRoot) : emptyTabsPane();
  const bottomRoot = r.bottomRoot ? sanitizePane(r.bottomRoot) : null;
  return {
    editorRoot,
    bottomRoot,
    activePaneId:
      typeof r.activePaneId === "string"
        ? (r.activePaneId as string)
        : firstLeaf(editorRoot).id,
    bottomVisible:
      typeof r.bottomVisible === "boolean" ? r.bottomVisible : true,
    sidebarVisible:
      typeof r.sidebarVisible === "boolean" ? r.sidebarVisible : true,
    expandedDirs: Array.isArray(r.expandedDirs)
      ? (r.expandedDirs as string[])
      : [],
    sidebarW: typeof r.sidebarW === "number" ? r.sidebarW : 240,
    termH: typeof r.termH === "number" ? r.termH : 240,
    sidebarView: (["files","git","tasks","todos","ai"] as SidebarView[]).includes(r.sidebarView as SidebarView) ? (r.sidebarView as SidebarView) : "files",
      pinned: Array.isArray((r as any).pinned) ? (r as any).pinned.filter((x: unknown) => typeof x === "string") : [],
      sidebarSections: parseSidebarSections((r as any).sidebarSections, (r.sidebarView as SidebarView) ?? "files"),
      sidebarSide: (r as any).sidebarSide === "right" ? "right" : "left",
      aiPanelVisible: (r as any).aiPanelVisible === true,
      aiPanelW:
        typeof (r as any).aiPanelW === "number"
          ? Math.max(220, Math.min(800, (r as any).aiPanelW))
          : 380,
  };
}

function parseSidebarSections(
  raw: unknown,
  fallback: SidebarView,
): SidebarSection[] {
  const validViews: SidebarView[] = ["files", "git", "tasks", "todos"];
  if (Array.isArray(raw)) {
    const out: SidebarSection[] = [];
    for (const r of raw) {
      if (!r || typeof r !== "object") continue;
      const v = (r as Record<string, unknown>).view;
      if (typeof v !== "string" || !validViews.includes(v as SidebarView))
        continue;
      out.push({
        view: v as SidebarView,
        collapsed: (r as Record<string, unknown>).collapsed === true,
        size:
          typeof (r as Record<string, unknown>).size === "number"
            ? Math.max(0.1, Math.min(10, (r as { size: number }).size))
            : 1,
      });
    }
    if (out.length > 0) return out;
  }
  return [
    {
      view: validViews.includes(fallback) ? fallback : "files",
      collapsed: false,
      size: 1,
    },
  ];
}

function parseTerminalsRaw(
  raw: unknown,
): Record<string, TerminalDescriptor> {
  const out: Record<string, TerminalDescriptor> = {};
  if (!raw || typeof raw !== "object") return out;
  for (const [id, val] of Object.entries(raw as Record<string, unknown>)) {
    if (!val || typeof val !== "object") continue;
    const v = val as Record<string, unknown>;
    if (typeof v.id !== "string" || typeof v.title !== "string") continue;
    const desc: TerminalDescriptor = {
      id: v.id,
      title: v.title,
      ptyId: typeof v.ptyId === "string" ? v.ptyId : undefined,
    };
    if (v.shell && typeof v.shell === "object") {
      const s = v.shell as Record<string, unknown>;
      if (
        typeof s.path === "string" &&
        typeof s.label === "string" &&
        Array.isArray(s.args)
      ) {
        desc.shell = {
          path: s.path,
          label: s.label,
          args: s.args.filter((a) => typeof a === "string") as string[],
        };
      }
    }
    out[id] = desc;
  }
  return out;
}

async function loadWorkspaceFromDisk(
  meta: WorkspaceMeta,
  liveSessionIds: Set<string>,
): Promise<WorkspaceData> {
  const raw = await wsApi.loadState(meta.id);
  let layoutRaw: unknown = raw;
  let terminalsRaw: unknown = null;
  if (
    raw &&
    typeof raw === "object" &&
    "layout" in (raw as Record<string, unknown>)
  ) {
    const r = raw as Record<string, unknown>;
    layoutRaw = r.layout;
    terminalsRaw = r.terminals ?? null;
  }
  const layout = normalizeLayout(layoutRaw);
  const allTerminals = parseTerminalsRaw(terminalsRaw);

  // Filter terminals to only those whose PTY is still alive in the backend.
  const liveTerminals: Record<string, TerminalDescriptor> = {};
  for (const [tid, desc] of Object.entries(allTerminals)) {
    if (desc.ptyId && liveSessionIds.has(desc.ptyId)) {
      liveTerminals[tid] = desc;
    }
  }

  // Collect file paths from the layout to load.
  const fileKeys: string[] = [];
  function collect(p: Pane) {
    if (p.kind === "tabs") {
      for (const k of p.tabs) {
        if (k.startsWith("file:")) fileKeys.push(k);
      }
    } else {
      collect(p.first);
      collect(p.second);
    }
  }
  collect(layout.editorRoot);
  if (layout.bottomRoot) collect(layout.bottomRoot);

  const files: Record<string, FileData> = {};
  await Promise.all(
    Array.from(new Set(fileKeys)).map(async (k) => {
      const path = k.slice(5);
      try {
        const c = await fsApi.readFile(path);
        files[path] = { contents: c, original: c };
      } catch {
        /* ignore */
      }
    }),
  );

  function clean(p: Pane): Pane | null {
    if (p.kind === "tabs") {
      const tabs = p.tabs.filter((k) => {
        if (k.startsWith("file:")) return files[k.slice(5)] !== undefined;
        if (k.startsWith("term:")) return liveTerminals[k.slice(5)] !== undefined;
        return false;
      });
      if (tabs.length === 0) return null;
      const active =
        p.active && tabs.includes(p.active)
          ? p.active
          : (tabs[tabs.length - 1] ?? null);
      return { ...p, tabs, active };
    }
    const first = clean(p.first);
    const second = clean(p.second);
    if (!first && !second) return null;
    if (!first) return second!;
    if (!second) return first;
    return { ...p, first, second };
  }
  const editorClean = clean(layout.editorRoot) ?? emptyTabsPane();
  const bottomClean = layout.bottomRoot ? clean(layout.bottomRoot) : null;
  return {
    meta,
    layout: {
      ...layout,
      editorRoot: editorClean,
      bottomRoot: bottomClean,
      activePaneId: firstLeaf(editorClean).id,
    },
    files,
    terminals: liveTerminals,
  };
}

export const useStore = create<AppState>((set, get) => {
  // Debounce per-workspace layout persistence so rapid actions (typing,
  // tab switches, splitter drags) don't spam the disk. Each workspace
  // has its own timer.
  const persistTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const PERSIST_DELAY = 300;
  const persistWs = (id: string) => {
    const existing = persistTimers.get(id);
    if (existing) clearTimeout(existing);
    persistTimers.set(
      id,
      setTimeout(async () => {
        persistTimers.delete(id);
        const ws = get().loaded[id];
        if (!ws) return;
        try {
          await wsApi.saveState(id, {
            layout: ws.layout,
            terminals: ws.terminals,
          });
        } catch {
          /* ignore — best-effort persistence */
        }
      }, PERSIST_DELAY),
    );
  };
  let idxTimer: ReturnType<typeof setTimeout> | null = null;
  const persistIdx = async () => {
    if (idxTimer) clearTimeout(idxTimer);
    idxTimer = setTimeout(async () => {
      idxTimer = null;
      const { recent, activeId, openIds } = get();
      try {
        await wsApi.save({ recent, active_id: activeId, open_ids: openIds });
      } catch {
        /* ignore */
      }
    }, 200);
  };
  const updateWs = (id: string, fn: (w: WorkspaceData) => WorkspaceData) => {
    set((s) => {
      const w = s.loaded[id];
      if (!w) return s;
      return { loaded: { ...s.loaded, [id]: fn(w) } };
    });
    persistWs(id);
  };

  return {
    recent: [],
    openIds: [],
    activeId: null,
    loaded: {},
    hydrated: false,
    hydrateProgress: {
      phase: "Starting up…",
      current: 0,
      total: 100,
    },

    hydrate: async () => {
      const setProg = (phase: string, current: number, total: number) => {
        set({ hydrateProgress: { phase, current, total } });
      };

      setProg("Reading workspace index…", 5, 100);
      const idx = await wsApi.load();
      const recent = idx.recent ?? [];
      const requestedOpen =
        idx.open_ids ?? (idx.active_id ? [idx.active_id] : []);
      let activeId = idx.active_id ?? requestedOpen[0] ?? null;

      setProg("Checking running shells…", 15, 100);
      let liveSessions = new Set<string>();
      try {
        const sessions = await ptyApi.listSessions();
        liveSessions = new Set(sessions.map((s) => s.id));
      } catch {
        /* ignore */
      }

      const total = Math.max(1, requestedOpen.length);
      const loaded: Record<string, WorkspaceData> = {};
      const survivingIds: string[] = [];

      for (let i = 0; i < requestedOpen.length; i++) {
        const id = requestedOpen[i];
        const meta = recent.find((w) => w.id === id);
        if (!meta) continue;
        const pct = 20 + Math.round(((i + 1) / total) * 70);
        setProg(`Opening ${meta.name}…`, pct, 100);
        try {
          const data = await loadWorkspaceFromDisk(meta, liveSessions);
          loaded[id] = data;
          survivingIds.push(id);
        } catch {
          /* skip */
        }
      }

      if (activeId && !loaded[activeId]) {
        activeId = survivingIds[0] ?? null;
      }

      setProg("Reattaching terminals…", 95, 100);
      set({
        recent,
        openIds: survivingIds,
        activeId,
        loaded,
        hydrated: true,
        hydrateProgress: { phase: "Ready", current: 100, total: 100 },
      });
      void persistIdx();
    },

    openWorkspace: async (root) => {
      const existing = get().recent.find((w) => w.root === root);
      const meta: WorkspaceMeta = existing
        ? { ...existing, last_opened: Date.now() }
        : {
            id: makeWsId(root),
            name: basename(root) || root,
            root,
            last_opened: Date.now(),
          };
      const recent = [
        meta,
        ...get().recent.filter((w) => w.id !== meta.id),
      ];
      let openIds = get().openIds;
      if (!openIds.includes(meta.id)) openIds = [...openIds, meta.id];
      let loaded = get().loaded;
      if (!loaded[meta.id]) {
        let liveSessions = new Set<string>();
        try {
          const sessions = await ptyApi.listSessions();
          liveSessions = new Set(sessions.map((s) => s.id));
        } catch {
          /* ignore */
        }
        try {
          const data = await loadWorkspaceFromDisk(meta, liveSessions);
          loaded = { ...loaded, [meta.id]: data };
        } catch {
          loaded = {
            ...loaded,
            [meta.id]: {
              meta,
              layout: defaultLayout(),
              files: {},
              terminals: {},
            },
          };
        }
      } else {
        loaded = {
          ...loaded,
          [meta.id]: { ...loaded[meta.id], meta },
        };
      }
      set({ recent, openIds, activeId: meta.id, loaded });
      await persistIdx();
    },

    closeWorkspace: async (id) => {
      const ws = get().loaded[id];
      if (ws) {
        const dirty = Object.values(ws.files).filter(
          (f) => f.contents !== f.original,
        );
        if (dirty.length > 0) {
          const ok = await dialogConfirm(
            `Discard unsaved changes in ${ws.meta.name}?`,
            {
              title: "Close workspace",
              okLabel: "Discard",
              cancelLabel: "Cancel",
              danger: true,
            },
          );
          if (!ok) return;
        }
        // Kill all PTYs we own in this workspace.
        for (const t of Object.values(ws.terminals)) {
          if (t.ptyId) void ptyApi.kill(t.ptyId).catch(() => {});
        }
        await wsApi.saveState(id, {
          layout: ws.layout,
          terminals: {},
        });
      }
      const openIds = get().openIds.filter((i) => i !== id);
      let activeId = get().activeId;
      if (activeId === id) activeId = openIds[openIds.length - 1] ?? null;
      const { [id]: _drop, ...rest } = get().loaded;
      set({ openIds, activeId, loaded: rest });
      void invoke("fs_watch_stop", { wsId: id }).catch(() => {});
      await persistIdx();
    },

    removeFromRecent: async (id) => {
      if (get().openIds.includes(id)) {
        await get().closeWorkspace(id);
      }
      const recent = get().recent.filter((w) => w.id !== id);
      set({ recent });
      await persistIdx();
    },

    setActiveWorkspace: async (id) => {
      if (!get().loaded[id]) return;
      set({ activeId: id });
      await persistIdx();
    },

    openFile: async (wsId, path) => {
      const ws = get().loaded[wsId];
      if (!ws) return;
      const k = fileKey(path);
      // Already open? Activate in its pane.
      const existingPane =
        findTabsPaneByTab(ws.layout.editorRoot, k) ??
        (ws.layout.bottomRoot
          ? findTabsPaneByTab(ws.layout.bottomRoot, k)
          : null);
      if (existingPane && ws.files[path]) {
        updateWs(wsId, (w) => ({
          ...w,
          layout: {
            ...w.layout,
            editorRoot: setActiveInPane(w.layout.editorRoot, existingPane.id, k),
            bottomRoot: w.layout.bottomRoot
              ? setActiveInPane(w.layout.bottomRoot, existingPane.id, k)
              : null,
            activePaneId: existingPane.id,
          },
        }));
        return;
      }
      let contents: string;
      try {
        contents = await fsApi.readFile(path);
      } catch (e) {
        console.error("openFile failed", e);
        return;
      }
      updateWs(wsId, (w) => {
        const targetPaneId =
          (w.layout.activePaneId &&
            isInTree(w.layout.editorRoot, w.layout.activePaneId) &&
            w.layout.activePaneId) ||
          firstLeaf(w.layout.editorRoot).id;
        const editorRoot = mapTree(w.layout.editorRoot, (t) =>
          t.id === targetPaneId
            ? {
                ...t,
                tabs: t.tabs.includes(k) ? t.tabs : [...t.tabs, k],
                active: k,
              }
            : t,
        );
        return {
          ...w,
          files: {
            ...w.files,
            [path]: { contents, original: contents },
          },
          layout: {
            ...w.layout,
            editorRoot,
            activePaneId: targetPaneId,
          },
        };
      });
    },

    closeTab: async (wsId, key) => {
      const ws = get().loaded[wsId];
      if (!ws) return;
      const parsed = parseKey(key);
      if (parsed?.kind === "terminal") {
        get().closeTerminal(wsId, parsed.id);
        return;
      }
      if (parsed?.kind === "file") {
        const f = ws.files[parsed.path];
        if (f && f.contents !== f.original) {
          const ok = await dialogConfirm(
            `Discard unsaved changes to ${basename(parsed.path)}?`,
            {
              title: "Close tab",
              okLabel: "Discard",
              cancelLabel: "Cancel",
              danger: true,
            },
          );
          if (!ok) return;
        }
      }
      updateWs(wsId, (w) => {
        const er = removeTabFromTree(w.layout.editorRoot, key);
        const editorRoot: Pane = er.tree ?? emptyTabsPane();
        let bottomRoot = w.layout.bottomRoot;
        if (bottomRoot) {
          const br = removeTabFromTree(bottomRoot, key);
          bottomRoot = br.tree;
        }
        let files = w.files;
        if (parsed?.kind === "file") {
          const { [parsed.path]: _drop, ...restFiles } = w.files;
          files = restFiles;
        }
        const activePaneId =
          w.layout.activePaneId &&
          (isInTree(editorRoot, w.layout.activePaneId) ||
            (bottomRoot ? isInTree(bottomRoot, w.layout.activePaneId) : false))
            ? w.layout.activePaneId
            : firstLeaf(editorRoot).id;
        return {
          ...w,
          files,
          layout: {
            ...w.layout,
            editorRoot,
            bottomRoot,
            activePaneId,
          },
        };
      });
    },

    setActiveTab: (wsId, paneId, key) =>
      updateWs(wsId, (w) => ({
        ...w,
        layout: {
          ...w.layout,
          editorRoot: setActiveInPane(w.layout.editorRoot, paneId, key),
          bottomRoot: w.layout.bottomRoot
            ? setActiveInPane(w.layout.bottomRoot, paneId, key)
            : null,
          activePaneId: paneId,
        },
      })),

    setActivePane: (wsId, paneId) =>
      updateWs(wsId, (w) => ({
        ...w,
        layout: { ...w.layout, activePaneId: paneId },
      })),

    setTabPinned: (wsId, key, pinned) =>
      updateWs(wsId, (w) => {
        const cur = w.layout.pinned ?? [];
        const has = cur.includes(key);
        if (pinned && !has) {
          return { ...w, layout: { ...w.layout, pinned: [...cur, key] } };
        }
        if (!pinned && has) {
          return {
            ...w,
            layout: { ...w.layout, pinned: cur.filter((p) => p !== key) },
          };
        }
        return w;
      }),

    moveTab: (wsId, key, target) => {
      updateWs(wsId, (w) => {
        const inEditor = isInTree(w.layout.editorRoot, target.paneId);
        const inBottom =
          !!w.layout.bottomRoot && isInTree(w.layout.bottomRoot, target.paneId);
        let editorRoot = w.layout.editorRoot;
        let bottomRoot = w.layout.bottomRoot;
        let activePaneId = w.layout.activePaneId;

        const applyToTree = (tree: Pane): { tree: Pane; activePaneId: PaneId } => {
          if ("insertIndex" in target) {
            return dropTabAtIndex(tree, target.paneId, target.insertIndex, key);
          }
          return dropTabAt(tree, target.paneId, target.edge, key);
        };

        if (inEditor) {
          if (bottomRoot) {
            const br = removeTabFromTree(bottomRoot, key);
            bottomRoot = br.tree;
          }
          const result = applyToTree(editorRoot);
          editorRoot = result.tree;
          activePaneId = result.activePaneId;
        } else if (inBottom && bottomRoot) {
          const er = removeTabFromTree(editorRoot, key);
          editorRoot = er.tree ?? emptyTabsPane();
          const result = applyToTree(bottomRoot);
          bottomRoot = result.tree;
          activePaneId = result.activePaneId;
        } else {
          // Target gone — fall back to editor first leaf.
          const er = removeTabFromTree(editorRoot, key);
          editorRoot = er.tree ?? emptyTabsPane();
          if (bottomRoot) {
            const br = removeTabFromTree(bottomRoot, key);
            bottomRoot = br.tree;
          }
          const leaf = firstLeaf(editorRoot);
          editorRoot = mapTree(editorRoot, (t) =>
            t.id === leaf.id
              ? {
                  ...t,
                  tabs: t.tabs.includes(key) ? t.tabs : [...t.tabs, key],
                  active: key,
                }
              : t,
          );
          activePaneId = leaf.id;
        }
        return {
          ...w,
          layout: { ...w.layout, editorRoot, bottomRoot, activePaneId },
        };
      });
    },

    setSplitRatio: (wsId, splitId, ratio) =>
      updateWs(wsId, (w) => {
        const editorRoot = setSplitRatioInTree(w.layout.editorRoot, splitId, ratio);
        const bottomRoot = w.layout.bottomRoot
          ? setSplitRatioInTree(w.layout.bottomRoot, splitId, ratio)
          : null;
        return { ...w, layout: { ...w.layout, editorRoot, bottomRoot } };
      }),

    updateFileContents: (wsId, path, contents) => {
      set((s) => {
        const w = s.loaded[wsId];
        if (!w) return s;
        const f = w.files[path];
        if (!f) return s;
        return {
          loaded: {
            ...s.loaded,
            [wsId]: {
              ...w,
              files: { ...w.files, [path]: { ...f, contents } },
            },
          },
        };
      });
    },

    saveFile: async (wsId, path) => {
      const ws = get().loaded[wsId];
      const f = ws?.files[path];
      if (!ws || !f || f.contents === f.original) return;
      const settings = getEditorSettings();
      let content = f.contents;
      if (settings.trimTrailingWhitespace) {
        content = content
          .split("\n")
          .map((line) => line.replace(/[ \t]+$/, ""))
          .join("\n");
      }
      if (
        settings.insertFinalNewline &&
        content.length > 0 &&
        !content.endsWith("\n")
      ) {
        content += "\n";
      }
      await fsApi.writeFile(path, content);
      set((s) => {
        const w = s.loaded[wsId];
        if (!w || !w.files[path]) return s;
        return {
          loaded: {
            ...s.loaded,
            [wsId]: {
              ...w,
              files: {
                ...w.files,
                [path]: { contents: content, original: content },
              },
            },
          },
        };
      });
    },

    saveAllFiles: async (wsId) => {
      const ws = get().loaded[wsId];
      if (!ws) return;
      const dirty = Object.entries(ws.files).filter(
        ([, f]) => f.contents !== f.original,
      );
      await Promise.all(dirty.map(([p]) => get().saveFile(wsId, p)));
    },

    toggleDir: (wsId, path) =>
      updateWs(wsId, (w) => {
        const cur = w.layout.expandedDirs;
        const next = cur.includes(path)
          ? cur.filter((p) => p !== path)
          : [...cur, path];
        return { ...w, layout: { ...w.layout, expandedDirs: next } };
      }),

    setSidebarW: (wsId, w) =>
      updateWs(wsId, (x) => ({ ...x, layout: { ...x.layout, sidebarW: w } })),

    setTermH: (wsId, h) =>
      updateWs(wsId, (x) => ({ ...x, layout: { ...x.layout, termH: h } })),

    setBottomVisible: (wsId, v) =>
      updateWs(wsId, (w) => ({
        ...w,
        layout: { ...w.layout, bottomVisible: v },
      })),

    setSidebarVisible: (wsId, v) =>
      updateWs(wsId, (w) => ({
        ...w,
        layout: { ...w.layout, sidebarVisible: v },
      })),

    setSidebarView: (wsId, v) =>
      updateWs(wsId, (w) => {
        // Activate the section: ensure it exists and isn't collapsed.
        const sections = w.layout.sidebarSections.slice();
        const idx = sections.findIndex((s) => s.view === v);
        if (idx === -1) {
          sections.push({ view: v, collapsed: false, size: 1 });
        } else {
          sections[idx] = { ...sections[idx], collapsed: false };
        }
        return {
          ...w,
          layout: { ...w.layout, sidebarView: v, sidebarSections: sections },
        };
      }),

    toggleSidebarSection: (wsId, view) =>
      updateWs(wsId, (w) => {
        const sections = w.layout.sidebarSections.slice();
        const idx = sections.findIndex((s) => s.view === view);
        if (idx === -1) {
          sections.push({ view, collapsed: false, size: 1 });
        } else {
          sections.splice(idx, 1);
          if (sections.length === 0) {
            sections.push({ view: "files", collapsed: false, size: 1 });
          }
        }
        return { ...w, layout: { ...w.layout, sidebarSections: sections } };
      }),

    removeSidebarSection: (wsId, view) =>
      updateWs(wsId, (w) => {
        const sections = w.layout.sidebarSections.filter(
          (s) => s.view !== view,
        );
        if (sections.length === 0) {
          sections.push({ view: "files", collapsed: false, size: 1 });
        }
        return { ...w, layout: { ...w.layout, sidebarSections: sections } };
      }),

    collapseSidebarSection: (wsId, view, collapsed) =>
      updateWs(wsId, (w) => {
        const sections = w.layout.sidebarSections.map((s) =>
          s.view === view ? { ...s, collapsed } : s,
        );
        return { ...w, layout: { ...w.layout, sidebarSections: sections } };
      }),

    setSidebarSectionSize: (wsId, view, size) =>
      updateWs(wsId, (w) => {
        const clamped = Math.max(0.1, Math.min(10, size));
        const sections = w.layout.sidebarSections.map((s) =>
          s.view === view ? { ...s, size: clamped } : s,
        );
        return { ...w, layout: { ...w.layout, sidebarSections: sections } };
      }),

    setSidebarSide: (wsId, side) =>
      updateWs(wsId, (w) => ({
        ...w,
        layout: { ...w.layout, sidebarSide: side },
      })),

    setAIPanelVisible: (wsId, visible) =>
      updateWs(wsId, (w) => ({
        ...w,
        layout: { ...w.layout, aiPanelVisible: visible },
      })),

    setAIPanelW: (wsId, w) =>
      updateWs(wsId, (ws) => ({
        ...ws,
        layout: {
          ...ws.layout,
          aiPanelW: Math.max(220, Math.min(800, w)),
        },
      })),

    reorderSidebarSection: (wsId, view, beforeView) =>
      updateWs(wsId, (w) => {
        const next = w.layout.sidebarSections.slice();
        const fromIdx = next.findIndex((s) => s.view === view);
        if (fromIdx === -1) return w;
        const [moved] = next.splice(fromIdx, 1);
        let toIdx = next.length;
        if (beforeView) {
          const i = next.findIndex((s) => s.view === beforeView);
          if (i !== -1) toIdx = i;
        }
        next.splice(toIdx, 0, moved);
        return { ...w, layout: { ...w.layout, sidebarSections: next } };
      }),

    addTerminal: (wsId, location = "bottom", shell) => {
      const id = makeTermId();
      const k = termKey(id);
      const existing = Object.keys(get().loaded[wsId]?.terminals ?? {}).length;
      const baseTitle = shell?.label ?? "Terminal";
      const title = `${baseTitle} ${existing + 1}`;
      updateWs(wsId, (w) => {
        const terminals = {
          ...w.terminals,
          [id]: { id, title, shell },
        };
        let editorRoot = w.layout.editorRoot;
        let bottomRoot = w.layout.bottomRoot;
        let activePaneId = w.layout.activePaneId;
        if (location === "editor") {
          const targetPaneId =
            (activePaneId && isInTree(editorRoot, activePaneId) && activePaneId) ||
            firstLeaf(editorRoot).id;
          editorRoot = mapTree(editorRoot, (t) =>
            t.id === targetPaneId
              ? { ...t, tabs: [...t.tabs, k], active: k }
              : t,
          );
          activePaneId = targetPaneId;
        } else {
          if (!bottomRoot) {
            bottomRoot = {
              kind: "tabs",
              id: makePaneId(),
              tabs: [k],
              active: k,
            };
          } else {
            const leafId = firstLeaf(bottomRoot).id;
            bottomRoot = mapTree(bottomRoot, (t) =>
              t.id === leafId
                ? { ...t, tabs: [...t.tabs, k], active: k }
                : t,
            );
          }
        }
        return {
          ...w,
          terminals,
          layout: {
            ...w.layout,
            editorRoot,
            bottomRoot,
            activePaneId,
            bottomVisible:
              location === "bottom" ? true : w.layout.bottomVisible,
          },
        };
      });
      return id;
    },

    setTerminalPtyId: (wsId, termId, ptyId) =>
      updateWs(wsId, (w) => {
        const t = w.terminals[termId];
        if (!t) return w;
        return {
          ...w,
          terminals: { ...w.terminals, [termId]: { ...t, ptyId } },
        };
      }),

    closeTerminal: (wsId, id) => {
      const ws = get().loaded[wsId];
      const desc = ws?.terminals[id];
      if (desc?.ptyId) {
        void ptyApi.kill(desc.ptyId).catch(() => {});
      }
      updateWs(wsId, (w) => {
        const k = termKey(id);
        const { [id]: _drop, ...restT } = w.terminals;
        const er = removeTabFromTree(w.layout.editorRoot, k);
        const editorRoot: Pane = er.tree ?? emptyTabsPane();
        let bottomRoot = w.layout.bottomRoot;
        if (bottomRoot) {
          const br = removeTabFromTree(bottomRoot, k);
          bottomRoot = pruneEmptyTabsPanes(br.tree);
        }
        const activePaneId =
          w.layout.activePaneId &&
          (isInTree(editorRoot, w.layout.activePaneId) ||
            (bottomRoot ? isInTree(bottomRoot, w.layout.activePaneId) : false))
            ? w.layout.activePaneId
            : firstLeaf(editorRoot).id;
        return {
          ...w,
          terminals: restT,
          layout: { ...w.layout, editorRoot, bottomRoot, activePaneId },
        };
      });
    },
  };
});
