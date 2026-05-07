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
export interface SymbolHit {
  path: string;
  line: number;
  /** "function" / "class" / "interface" / "type" / "enum" / "struct"
   *  / "trait" / "impl" / "fn" / "def" / "func" / "const" / "var". */
  kind: string;
  name: string;
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
  searchRegex: (
    root: string,
    pattern: string,
    caseSensitive = false,
    maxResults = 500,
  ) =>
    invoke<SearchHit[]>("search_regex", {
      root,
      pattern,
      caseSensitive,
      maxResults,
    }),
  scanTodos: (root: string, maxResults = 1000) =>
    invoke<TodoHit[]>("scan_todos", { root, maxResults }),
  findSymbols: (root: string, maxResults = 3000) =>
    invoke<SymbolHit[]>("find_symbols", { root, maxResults }),
  readPackageScripts: (root: string) =>
    invoke<PackageScript[]>("read_package_scripts", { root }),
};

export interface ClaudeSession {
  id: string;
  title: string;
  preview: string;
  cost_usd: number;
  turn_count: number;
  last_turn_at_ms: number;
}

export interface LoadedToolCall {
  id?: string;
  function: {
    name: string;
    arguments: Record<string, unknown>;
  };
}

export interface LoadedToolResult {
  tool_use_id: string;
  content: string;
  is_error?: boolean;
}

export interface LoadedMessage {
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: LoadedToolCall[];
  tool_results?: LoadedToolResult[];
}

export const claudeCode = {
  /** List on-disk Claude Code sessions for the given workspace cwd. */
  listSessions: (cwd: string) =>
    invoke<ClaudeSession[]>("claude_code_list_sessions", { cwd }),
  /** Reconstruct the full conversation from a session's JSONL file. */
  loadSession: (cwd: string, sessionId: string) =>
    invoke<LoadedMessage[]>("claude_code_load_session", {
      cwd,
      sessionId,
    }),
};

export interface McpServer {
  name: string;
  scope: "user" | "project";
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export const claudeMcp = {
  /** List installed MCP servers from user (~/.claude.json) +
   *  project (.mcp.json) scopes, sorted by name. */
  list: (cwd: string) =>
    invoke<McpServer[]>("claude_mcp_list", { cwd }),
  /** Add or replace an MCP server in the given scope. */
  add: (
    cwd: string,
    name: string,
    scope: "user" | "project",
    command: string,
    args: string[],
    env: Record<string, string>,
  ) =>
    invoke<string>("claude_mcp_add", {
      cwd,
      name,
      scope,
      command,
      args,
      env,
    }),
  /** Remove an MCP server from the given scope (no-op if absent). */
  remove: (cwd: string, name: string, scope: "user" | "project") =>
    invoke<void>("claude_mcp_remove", { cwd, name, scope }),
};

export interface GitFile {
  path: string;
  /** First char of porcelain "XY" — staged side. " " = unchanged. */
  index_status: string;
  /** Second char of porcelain "XY" — worktree side. " " = unchanged. */
  worktree_status: string;
  staged: boolean;
  modified: boolean;
}

export interface GitStatus {
  is_repo: boolean;
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: GitFile[];
}

export interface GitCommit {
  hash: string;
  full_hash: string;
  subject: string;
  author_name: string;
  author_email: string;
  timestamp: number;
  parents: string;
}

export const git = {
  status: (path: string) => invoke<GitStatus>("git_status", { path }),
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
  log: (path: string, limit = 50) =>
    invoke<GitCommit[]>("git_log", { path, limit }),
  showCommit: (path: string, refspec: string) =>
    invoke<string>("git_show_commit", { path, refspec }),
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
