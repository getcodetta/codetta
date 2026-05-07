// AI privacy exclusions — a per-machine glob list of paths that NO AI
// provider (Claude Code, Anthropic, OpenAI, Ollama) is allowed to
// receive. The Claude Code permission overlay denies tool calls
// whose target matches; the chat panel filters /file attachments;
// the chat panel renders a warning banner when the active editor
// file matches.
//
// Storage: localStorage on this machine. Travels with the user, not
// with the workspace, because privacy preferences shouldn't depend
// on which folder is open.
//
// Default list ships with the obvious sensitive surfaces (.env,
// SSH/GPG keys, AWS creds) so the very first user with no
// configuration is still protected from the most common leaks.

import { getJson, setJson } from "./localStore";

const KEY = "lcp.ai.privacy.exclusions";

/** Patterns shipped on by default. The user can remove them via
 *  Settings — but we'd rather start with safety than start naked. */
export const DEFAULT_EXCLUSIONS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/*.pem",
  "**/*.key",
  "**/id_rsa",
  "**/id_rsa.pub",
  "**/id_ed25519",
  "**/id_ed25519.pub",
  "**/secrets/**",
  "**/.aws/**",
  "**/.ssh/**",
  "**/.gnupg/**",
  "**/credentials.json",
  "**/service-account*.json",
];

interface PrivacySettings {
  /** When false, the entire exclusion system is bypassed — the user
   *  has explicitly opted out of all guards. */
  enabled: boolean;
  /** User-supplied patterns layered on top of (or replacing) the
   *  defaults. See `useDefaults`. */
  patterns: string[];
  /** When true (default), DEFAULT_EXCLUSIONS are ALSO checked. When
   *  false, only `patterns` is used — a power-user escape hatch. */
  useDefaults: boolean;
}

// In-memory listener registry so React components observing the
// settings can refresh when Settings edits the list.
type Listener = () => void;
const listeners = new Set<Listener>();
function notify() {
  // Drop the cached settings + compiled-regex derived caches so the
  // next matchExclusion call rebuilds against the new list. Without
  // this, a Settings edit to the exclusion list wouldn't take effect
  // until the page reloaded.
  cachedSettings = null;
  cachedPatternList = null;
  for (const l of listeners) l();
}

// Cached settings + derived pattern list. Rebuilt lazily on next read
// after a save() invalidates them. localStorage parses on every load
// were a real cost when the AI panel re-renders during streaming.
let cachedSettings: PrivacySettings | null = null;
let cachedPatternList: string[] | null = null;

export function loadPrivacySettings(): PrivacySettings {
  if (cachedSettings) return cachedSettings;
  const parsed = getJson<Record<string, unknown>>(
    KEY,
    {},
    (p): p is Record<string, unknown> => !!p && typeof p === "object",
  );
  const out: PrivacySettings = {
    enabled: parsed.enabled !== false,
    patterns: Array.isArray(parsed.patterns)
      ? parsed.patterns.filter((p: unknown): p is string => typeof p === "string")
      : [],
    useDefaults: parsed.useDefaults !== false,
  };
  cachedSettings = out;
  return out;
}

export function savePrivacySettings(next: PrivacySettings) {
  setJson(KEY, next);
  notify();
}

export function subscribePrivacy(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Effective pattern list — defaults + user patterns when both
 *  are enabled, just user patterns otherwise. */
export function effectivePatterns(s?: PrivacySettings): string[] {
  // Fast path for the default caller (no override settings). Reuses
  // the cached list invalidated by notify() on save.
  if (!s && cachedPatternList) return cachedPatternList;
  const settings = s ?? loadPrivacySettings();
  if (!settings.enabled) {
    if (!s) cachedPatternList = [];
    return [];
  }
  const out: string[] = settings.useDefaults
    ? [...DEFAULT_EXCLUSIONS]
    : [];
  for (const p of settings.patterns) {
    const trimmed = p.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  if (!s) cachedPatternList = out;
  return out;
}

// ---------- Glob matcher ----------
//
// We support a tight, predictable subset of git-style globs because
// privacy decisions need to be auditable. No bracket sets, no
// negations, no globstar in the middle of a name. Just enough:
//
//   *      → matches any sequence of chars except path separator
//   **     → matches any sequence of chars including path separators
//                (must occupy a full segment between /…/, except at start/end)
//   ?      → matches a single char that isn't a path separator
//   /…     → segment separator (forward slash; backslashes normalised first)
//   ext.   → no special meaning; literal match
//
// Examples:
//   "**/.env"              matches  /any/path/.env
//   "**/.env.*"            matches  /any/.env.local but NOT /any/.env
//   "secrets/**"           matches  ANY-DEPTH under secrets/
//   "**/id_rsa"            matches  /home/user/.ssh/id_rsa
//
// Matched against the path's forward-slash form (Windows or POSIX).
// Case-insensitive on Windows (matches the OS), case-sensitive elsewhere.

function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/");
  // Strip Windows drive letter — globs are written without one. The
  // path AFTER the drive ("C:/Users/foo") becomes "/Users/foo" so a
  // pattern like "**/.env" can match.
  if (/^[a-zA-Z]:\//.test(n)) n = n.slice(2);
  return n;
}

// Detect once at module load — navigator.platform is stable for the
// lifetime of the page, and most callers were re-running this regex
// inside a hot loop.
const REGEX_FLAGS =
  typeof navigator !== "undefined" &&
  /win/i.test(navigator.platform || "")
    ? "i"
    : "";

// Compiled regex cache keyed by raw pattern string. Patterns rarely
// change at runtime; recompiling on every matchExclusion call was
// pure overhead. We cap the cache so a runaway "edit settings every
// frame" loop can't grow it unbounded.
const regexCache = new Map<string, RegExp | null>();
const REGEX_CACHE_MAX = 256;

function compileGlob(pattern: string): RegExp | null {
  const cached = regexCache.get(pattern);
  if (cached !== undefined) return cached;
  let p = pattern.trim();
  // Always anchor at start; allow end. Globs are full-path matches.
  let re = "^";
  let i = 0;
  while (i < p.length) {
    const ch = p[i];
    if (ch === "*" && p[i + 1] === "*") {
      // ** → match anything across path separators
      re += ".*";
      i += 2;
      // Optional trailing slash absorbed: "**/foo" → match foo at any depth
      if (p[i] === "/") i++;
    } else if (ch === "*") {
      // * → match anything except path separator
      re += "[^/]*";
      i++;
    } else if (ch === "?") {
      re += "[^/]";
      i++;
    } else if (ch === "/") {
      re += "/";
      i++;
    } else {
      // Literal — escape regex special chars
      re += ch.replace(/[.+^${}()|[\]\\]/g, "\\$&");
      i++;
    }
  }
  re += "$";
  let result: RegExp | null;
  try {
    result = new RegExp(re, REGEX_FLAGS);
  } catch {
    // Bad pattern — cache the null so we don't retry compilation.
    result = null;
  }
  if (regexCache.size >= REGEX_CACHE_MAX) {
    // Evict the oldest entry. Map iteration order is insertion order.
    const firstKey = regexCache.keys().next().value;
    if (firstKey !== undefined) regexCache.delete(firstKey);
  }
  regexCache.set(pattern, result);
  return result;
}

/** Returns the matched pattern (for explainable denials) or null. */
export function matchExclusion(
  absolutePath: string,
  patterns?: string[],
): string | null {
  if (!absolutePath) return null;
  const list = patterns ?? effectivePatterns();
  if (list.length === 0) return null;
  const norm = normalizePath(absolutePath);
  for (const pat of list) {
    const re = compileGlob(pat);
    if (re && re.test(norm)) return pat;
  }
  return null;
}

