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
  createFile: (path: string) => invoke<void>("create_file", { path }),
  exists: (path: string) => invoke<boolean>("path_exists", { path }),
};

export interface ShellOption {
  id: string;
  label: string;
  path: string;
  args: string[];
}

export interface SessionInfo {
  id: string;
  cwd: string | null;
  shell_path: string;
  title: string;
}

export const pty = {
  spawn: (opts: {
    shell?: string;
    args?: string[];
    cwd?: string;
    cols: number;
    rows: number;
    title?: string;
  }) => invoke<string>("pty_spawn", opts),
  write: (id: string, data: string) =>
    invoke<void>("pty_write", { id, data }),
  resize: (id: string, cols: number, rows: number) =>
    invoke<void>("pty_resize", { id, cols, rows }),
  kill: (id: string) => invoke<void>("pty_kill", { id }),
  availableShells: () => invoke<ShellOption[]>("available_shells"),
  listSessions: () => invoke<SessionInfo[]>("pty_list_sessions"),
  sessionExists: (id: string) =>
    invoke<boolean>("pty_session_exists", { id }),
  getBuffer: (id: string) => invoke<string>("pty_get_buffer", { id }),
  onOutput: (cb: (id: string, data: string) => void): Promise<UnlistenFn> =>
    listen<{ id: string; data: string }>("pty:output", (e) =>
      cb(e.payload.id, e.payload.data),
    ),
  onExit: (cb: (id: string) => void): Promise<UnlistenFn> =>
    listen<{ id: string }>("pty:exit", (e) => cb(e.payload.id)),
};

export interface SearchHit {
  path: string;
  line: number;
  col: number;
  text: string;
}
export interface TodoHit {
  path: string;
  line: number;
  kind: string;
  text: string;
}
export interface PackageScript {
  name: string;
  command: string;
}

export const search = {
  listFiles: (root: string, max?: number) =>
    invoke<string[]>("list_workspace_files", { root, max }),
  searchText: (
    root: string,
    query: string,
    caseSensitive = false,
    maxResults = 500,
  ) =>
    invoke<SearchHit[]>("search_text", {
      root,
      query,
      caseSensitive,
      maxResults,
    }),
  scanTodos: (root: string, maxResults = 1000) =>
    invoke<TodoHit[]>("scan_todos", { root, maxResults }),
  readPackageScripts: (root: string) =>
    invoke<PackageScript[]>("read_package_scripts", { root }),
};

export const git = {
  status: (path: string) => invoke<unknown>("git_status", { path }),
  diff: (path: string, file?: string) =>
    invoke<string>("git_diff", { path, file: file ?? null }),
  diffStaged: (path: string, file?: string) =>
    invoke<string>("git_diff_staged", { path, file: file ?? null }),
  show: (path: string, refspec: string, file: string) =>
    invoke<string>("git_show", { path, refspec, file }),
  discard: (path: string, files: string[]) =>
    invoke<string>("git_discard", { path, files }),
  branches: (path: string) => invoke<string[]>("git_branches", { path }),
  checkoutBranch: (path: string, branch: string) =>
    invoke<string>("git_checkout_branch", { path, branch }),
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
  open_ids?: string[];
}

export const workspaces = {
  load: () => invoke<WorkspacesIndex>("workspaces_load"),
  save: (index: WorkspacesIndex) => invoke<void>("workspaces_save", { index }),
  loadState: (id: string) =>
    invoke<unknown>("workspace_state_load", { id }),
  saveState: (id: string, state: unknown) =>
    invoke<void>("workspace_state_save", { id, state }),
};
