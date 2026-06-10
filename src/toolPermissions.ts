// Per-tool permission policy. The chat loop consults this before executing a
// tool call so the user can globally opt a tool in or out, be asked each
// time, or maintain a persistent allowlist (per-tool or per-path) populated
// from the inline "Allow always" / "Allow this path" actions in chat.

import { getJson, setJson } from "./localStore";

export type ToolPermission = "allow" | "ask" | "deny";

export interface ToolPolicy {
  read: ToolPermission;
  webSearch: ToolPermission;
  write: ToolPermission;
  /** Tool names the user has clicked "Allow always" on. */
  alwaysAllowedTools: string[];
  /** Tool name → list of allowed paths/queries. */
  alwaysAllowedPaths: Record<string, string[]>;
}

const KEY = "lcp.toolPolicy";

const DEFAULTS: ToolPolicy = {
  read: "allow",
  webSearch: "allow",
  write: "ask",
  alwaysAllowedTools: [],
  alwaysAllowedPaths: {},
};

// Cached policy. Parsed once on first read and reused until setToolPolicy
// invalidates it. Tool calls inside a single chat turn used to re-parse
// localStorage on every call; the cache cuts the per-call cost to a
// pointer dereference.
let cachedPolicy: ToolPolicy | null = null;

export function getToolPolicy(): ToolPolicy {
  if (cachedPolicy) return cachedPolicy;
  const obj = getJson<Partial<ToolPolicy>>(
    KEY,
    {},
    (p): p is Partial<ToolPolicy> => !!p && typeof p === "object",
  );
  const out: ToolPolicy = {
    read: norm(obj.read, DEFAULTS.read),
    webSearch: norm(obj.webSearch, DEFAULTS.webSearch),
    write: norm(obj.write, DEFAULTS.write),
    alwaysAllowedTools: Array.isArray(obj.alwaysAllowedTools)
      ? obj.alwaysAllowedTools.filter(
          (s): s is string => typeof s === "string",
        )
      : [],
    alwaysAllowedPaths:
      obj.alwaysAllowedPaths && typeof obj.alwaysAllowedPaths === "object"
        ? Object.fromEntries(
            Object.entries(obj.alwaysAllowedPaths).map(([k, v]) => [
              k,
              Array.isArray(v)
                ? v.filter((s): s is string => typeof s === "string")
                : [],
            ]),
          )
        : {},
  };
  cachedPolicy = out;
  return out;
}

function norm(v: unknown, fallback: ToolPermission): ToolPermission {
  return v === "allow" || v === "ask" || v === "deny" ? v : fallback;
}

type PolicyListener = () => void;
const policyListeners = new Set<PolicyListener>();

/** Subscribe to policy writes (Settings rows, chat-side "Allow always").
 *  Returns an unsubscribe. */
export function onToolPolicyChange(fn: PolicyListener): () => void {
  policyListeners.add(fn);
  return () => {
    policyListeners.delete(fn);
  };
}

export function setToolPolicy(policy: ToolPolicy): void {
  cachedPolicy = policy;
  setJson(KEY, policy);
  for (const fn of policyListeners) fn();
}

export function rememberToolAlways(toolName: string): void {
  const p = getToolPolicy();
  if (!p.alwaysAllowedTools.includes(toolName)) {
    p.alwaysAllowedTools = [...p.alwaysAllowedTools, toolName];
    setToolPolicy(p);
  }
}

export function rememberToolPath(toolName: string, path: string): void {
  const p = getToolPolicy();
  const cur = p.alwaysAllowedPaths[toolName] ?? [];
  if (!cur.includes(path)) {
    p.alwaysAllowedPaths = {
      ...p.alwaysAllowedPaths,
      [toolName]: [...cur, path],
    };
    setToolPolicy(p);
  }
}

const READ_TOOLS = new Set([
  "list_files",
  "read_file",
  "search_text",
  "read_terminal",
]);
const WEB_TOOLS = new Set(["web_search"]);
const WRITE_TOOLS = new Set(["edit_file", "create_file"]);

/**
 * Resolve the permission for a specific tool call. Allowlists win over the
 * category default; specifically:
 *   1. If the tool is in alwaysAllowedTools → "allow"
 *   2. If the call's path/query matches an entry in alwaysAllowedPaths →
 *      "allow"
 *   3. Otherwise → category default
 */
export function permissionFor(
  toolName: string,
  args?: Record<string, unknown>,
): ToolPermission {
  const p = getToolPolicy();
  if (p.alwaysAllowedTools.includes(toolName)) return "allow";
  const paths = p.alwaysAllowedPaths[toolName];
  if (paths && paths.length > 0 && args) {
    const candidate = extractPathArg(args);
    if (candidate && paths.includes(candidate)) return "allow";
  }
  if (READ_TOOLS.has(toolName)) return p.read;
  if (WEB_TOOLS.has(toolName)) return p.webSearch;
  if (WRITE_TOOLS.has(toolName)) return p.write;
  return "ask";
}

/** Pull the most identifying string arg out of a tool call for path-allow. */
export function extractPathArg(
  args: Record<string, unknown>,
): string | null {
  const candidates = ["path", "file_path", "query", "pattern", "command"];
  for (const k of candidates) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}
