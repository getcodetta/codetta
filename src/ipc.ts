import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export interface DirEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

export const fs = {
  listDir: (path: string) => invoke<DirEntry[]>("list_dir", { path }),
  readFile: (path: string) => invoke<string>("read_file", { path }),
  writeFile: (path: string, contents: string) =>
    invoke<void>("write_file", { path, contents }),
  rename: (from: string, to: string) =>
    invoke<void>("rename_path", { from, to }),
  delete: (path: string) => invoke<void>("delete_path", { path }),
  createDir: (path: string) => invoke<void>("create_dir", { path }),
  exists: (path: string) => invoke<boolean>("path_exists", { path }),
};

export const pty = {
  spawn: (opts: {
    shell?: string;
    cwd?: string;
    cols: number;
    rows: number;
  }) => invoke<string>("pty_spawn", opts),
  write: (id: string, data: string) =>
    invoke<void>("pty_write", { id, data }),
  resize: (id: string, cols: number, rows: number) =>
    invoke<void>("pty_resize", { id, cols, rows }),
  kill: (id: string) => invoke<void>("pty_kill", { id }),
  onOutput: (cb: (id: string, data: string) => void): Promise<UnlistenFn> =>
    listen<{ id: string; data: string }>("pty:output", (e) =>
      cb(e.payload.id, e.payload.data),
    ),
  onExit: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<{ id: string }>("pty:exit", (e) => cb(e.payload.id)),
};

export interface WorkspaceMeta {
  id: string;
  name: string;
  root: string;
  last_opened: number;
}

export interface WorkspacesIndex {
  recent: WorkspaceMeta[];
  active_id: string | null;
}

export const workspaces = {
  load: () => invoke<WorkspacesIndex>("workspaces_load"),
  save: (index: WorkspacesIndex) => invoke<void>("workspaces_save", { index }),
  loadState: (id: string) =>
    invoke<unknown>("workspace_state_load", { id }),
  saveState: (id: string, state: unknown) =>
    invoke<void>("workspace_state_save", { id, state }),
};
