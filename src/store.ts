import { create } from "zustand";
import { workspaces as wsApi, type WorkspaceMeta } from "./ipc";

export interface Tab {
  path: string;
  contents: string;
  original: string;
}

interface PerWorkspaceState {
  openTabs: string[];
  activeTab: string | null;
  expandedDirs: string[];
}

interface AppState {
  recent: WorkspaceMeta[];
  activeId: string | null;
  loadedWorkspaceState: PerWorkspaceState;
  tabs: Record<string, Tab>;
  hydrated: boolean;

  hydrate: () => Promise<void>;
  openWorkspace: (root: string) => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;
  removeWorkspace: (id: string) => Promise<void>;

  openFile: (path: string) => Promise<void>;
  closeTab: (path: string) => void;
  setActiveTab: (path: string) => void;
  updateTabContents: (path: string, contents: string) => void;
  saveTab: (path: string) => Promise<void>;

  toggleDir: (path: string) => void;

  persistWorkspaceState: () => Promise<void>;
}

const emptyWsState: PerWorkspaceState = {
  openTabs: [],
  activeTab: null,
  expandedDirs: [],
};

function basename(p: string): string {
  const norm = p.replace(/\\/g, "/").replace(/\/+$/, "");
  const idx = norm.lastIndexOf("/");
  return idx >= 0 ? norm.slice(idx + 1) : norm;
}

function makeId(root: string): string {
  // simple stable id from path
  let h = 0;
  for (let i = 0; i < root.length; i++) h = (h * 31 + root.charCodeAt(i)) | 0;
  return `ws_${Math.abs(h).toString(36)}_${root.length.toString(36)}`;
}

export const useStore = create<AppState>((set, get) => ({
  recent: [],
  activeId: null,
  loadedWorkspaceState: emptyWsState,
  tabs: {},
  hydrated: false,

  hydrate: async () => {
    const idx = await wsApi.load();
    set({
      recent: idx.recent ?? [],
      activeId: idx.active_id ?? null,
      hydrated: true,
    });
    if (idx.active_id) {
      await get().switchWorkspace(idx.active_id);
    }
  },

  openWorkspace: async (root) => {
    const existing = get().recent.find((w) => w.root === root);
    let meta: WorkspaceMeta;
    if (existing) {
      meta = { ...existing, last_opened: Date.now() };
    } else {
      meta = {
        id: makeId(root),
        name: basename(root) || root,
        root,
        last_opened: Date.now(),
      };
    }
    const recent = [meta, ...get().recent.filter((w) => w.id !== meta.id)];
    set({ recent, activeId: meta.id });
    await wsApi.save({ recent, active_id: meta.id });
    await get().switchWorkspace(meta.id);
  },

  switchWorkspace: async (id) => {
    // persist current before switching
    if (get().activeId && get().activeId !== id) {
      await get().persistWorkspaceState();
    }
    const recent = get().recent.map((w) =>
      w.id === id ? { ...w, last_opened: Date.now() } : w,
    );
    set({ recent, activeId: id, tabs: {} });
    await wsApi.save({ recent, active_id: id });

    const raw = (await wsApi.loadState(id)) as PerWorkspaceState | null;
    const wsState = raw && typeof raw === "object" ? raw : emptyWsState;
    set({ loadedWorkspaceState: wsState });

    // re-open tabs that still exist
    for (const p of wsState.openTabs ?? []) {
      try {
        await get().openFile(p);
      } catch {
        /* file gone, ignore */
      }
    }
    if (wsState.activeTab && get().tabs[wsState.activeTab]) {
      set({
        loadedWorkspaceState: {
          ...get().loadedWorkspaceState,
          activeTab: wsState.activeTab,
        },
      });
    }
  },

  removeWorkspace: async (id) => {
    const recent = get().recent.filter((w) => w.id !== id);
    const activeId = get().activeId === id ? null : get().activeId;
    set({ recent, activeId, tabs: {}, loadedWorkspaceState: emptyWsState });
    await wsApi.save({ recent, active_id: activeId });
  },

  openFile: async (path) => {
    if (get().tabs[path]) {
      set((s) => ({
        loadedWorkspaceState: { ...s.loadedWorkspaceState, activeTab: path },
      }));
      return;
    }
    const { fs } = await import("./ipc");
    const contents = await fs.readFile(path);
    set((s) => ({
      tabs: { ...s.tabs, [path]: { path, contents, original: contents } },
      loadedWorkspaceState: {
        ...s.loadedWorkspaceState,
        openTabs: s.loadedWorkspaceState.openTabs.includes(path)
          ? s.loadedWorkspaceState.openTabs
          : [...s.loadedWorkspaceState.openTabs, path],
        activeTab: path,
      },
    }));
    await get().persistWorkspaceState();
  },

  closeTab: (path) => {
    set((s) => {
      const { [path]: _, ...rest } = s.tabs;
      const open = s.loadedWorkspaceState.openTabs.filter((p) => p !== path);
      const activeTab =
        s.loadedWorkspaceState.activeTab === path
          ? open[open.length - 1] ?? null
          : s.loadedWorkspaceState.activeTab;
      return {
        tabs: rest,
        loadedWorkspaceState: {
          ...s.loadedWorkspaceState,
          openTabs: open,
          activeTab,
        },
      };
    });
    void get().persistWorkspaceState();
  },

  setActiveTab: (path) => {
    set((s) => ({
      loadedWorkspaceState: { ...s.loadedWorkspaceState, activeTab: path },
    }));
    void get().persistWorkspaceState();
  },

  updateTabContents: (path, contents) => {
    set((s) => {
      const t = s.tabs[path];
      if (!t) return s;
      return { tabs: { ...s.tabs, [path]: { ...t, contents } } };
    });
  },

  saveTab: async (path) => {
    const tab = get().tabs[path];
    if (!tab) return;
    const { fs } = await import("./ipc");
    await fs.writeFile(path, tab.contents);
    set((s) => ({
      tabs: {
        ...s.tabs,
        [path]: { ...tab, original: tab.contents },
      },
    }));
  },

  toggleDir: (path) => {
    set((s) => {
      const cur = s.loadedWorkspaceState.expandedDirs;
      const next = cur.includes(path)
        ? cur.filter((p) => p !== path)
        : [...cur, path];
      return {
        loadedWorkspaceState: { ...s.loadedWorkspaceState, expandedDirs: next },
      };
    });
    void get().persistWorkspaceState();
  },

  persistWorkspaceState: async () => {
    const id = get().activeId;
    if (!id) return;
    await wsApi.saveState(id, get().loadedWorkspaceState);
  },
}));
