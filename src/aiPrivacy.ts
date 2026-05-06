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

const DEFAULT_SETTINGS: PrivacySettings = {
  enabled: true,
  patterns: [],
  useDefaults: true,
};

// In-memory listener registry so React components observing the
// settings can refresh when Settings edits the list.
type Listener = () => void;
const listeners = new Set<Listener>();
function notify() {
  for (const l of listeners) l();
}

export function loadPrivacySettings(): PrivacySettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return { ...DEFAULT_SETTINGS };
    return {
      enabled: parsed.enabled !== false,
      patterns: Array.isArray(parsed.patterns)
        ? parsed.patterns.filter((p: unknown) => typeof p === "string")
        : [],
      useDefaults: parsed.useDefaults !== false,
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function savePrivacySettings(next: PrivacySettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* localStorage full — best-effort */
  }
  notify();
}

export function subscribePrivacy(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Effective pattern list — defaults + user patterns when both
 *  are enabled, just user patterns otherwise. */
export function effectivePatterns(s?: PrivacySettings): string[] {
  const settings = s ?? loadPrivacySettings();
  if (!settings.enabled) return [];
  const out: string[] = settings.useDefaults
    ? [...DEFAULT_EXCLUSIONS]
    : [];
  for (const p of settings.patterns) {
    const trimmed = p.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
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

function isWindowsPath(p: string): boolean {
  return /^[a-zA-Z]:[/\\]/.test(p);
}

function normalizePath(p: string): string {
  let n = p.replace(/\\/g, "/");
  // Strip Windows drive letter — globs are written without one. The
  // path AFTER the drive ("C:/Users/foo") becomes "/Users/foo" so a
  // pattern like "**/.env" can match.
  if (/^[a-zA-Z]:\//.test(n)) n = n.slice(2);
  return n;
}

function globToRegex(pattern: string): RegExp {
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
  // Windows: case-insensitive to match the OS.
  const flags =
    typeof navigator !== "undefined" &&
    /win/i.test(navigator.platform || "")
      ? "i"
      : "";
  return new RegExp(re, flags);
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
    try {
      if (globToRegex(pat).test(norm)) return pat;
    } catch {
      // Bad pattern — skip silently rather than crash the AI flow
    }
  }
  return null;
}

export function isExcluded(absolutePath: string, patterns?: string[]): boolean {
  return matchExclusion(absolutePath, patterns) !== null;
}

// Re-export so callers don't need to know about the helper directly.
export { isWindowsPath as _isWindowsPath };
