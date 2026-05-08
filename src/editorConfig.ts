// Tiny per-file `.editorconfig` reader. When a project ships an
// `.editorconfig` (https://editorconfig.org/), opening a file in that
// project should respect its `indent_size`, `tab_width`, `indent_style`,
// `end_of_line`, and `insert_final_newline` settings — overriding the
// global editor settings just for that file's session.
//
// Caveats / scope of the v1 implementation:
//
//  - Resolution is async + per-file-open. Rapid tab swaps will see a
//    brief flash of the global tab size before the override applies.
//    Acceptable for now — the override lands within a microtask of the
//    fs.readFile resolving and Monaco re-renders cheaply.
//
//  - We do NOT watch `.editorconfig` itself for changes. If the user
//    edits the file's indent rules, they need to close and reopen any
//    affected files to pick up the new values. Future enhancement.
//
//  - The glob subset we recognise is deliberately small: literal name,
//    `*` (any characters within a path segment), `*.ext`, and the brace
//    form `*.{ext1,ext2}`. We do NOT handle `**` (deep recursion) or
//    character classes — those are rare in real-world `.editorconfig`s
//    and would balloon the parser. Patterns we don't understand simply
//    don't match, so an exotic section gets ignored rather than mis-
//    applied.
//
//  - Only the six keys called out above are honoured. Unknown keys are
//    silently dropped — this matches the editorconfig spec's "ignore
//    what you don't understand" guidance.

import { fs } from "./ipc";
import { basename, dirname } from "./pathUtils";

export interface EditorConfigResolved {
  /** Indent width in columns. Clamped to 1..16 during parsing. */
  indent_size?: number;
  /** Tab display width. Falls back to indent_size when absent. */
  tab_width?: number;
  indent_style?: "tab" | "space";
  end_of_line?: "lf" | "crlf" | "cr";
  insert_final_newline?: boolean;
  trim_trailing_whitespace?: boolean;
}

interface ParsedFile {
  /** True when the file declared `root = true` at top level. */
  root: boolean;
  sections: ParsedSection[];
}

interface ParsedSection {
  /** Original pattern string, kept for debugging. */
  pattern: string;
  /** Compiled basename matcher. */
  matches: (basename: string) => boolean;
  values: EditorConfigResolved;
}

/**
 * Walk from `filePath`'s directory up to the workspace `root`, reading
 * any `.editorconfig` files along the way. Sections that match the
 * file's basename are merged (later, more-specific = higher priority);
 * a file with `root = true` stops the walk.
 *
 * Returns an empty object if no `.editorconfig` exists, or if every
 * file we found had no matching section. Failures (read errors,
 * malformed lines) are swallowed — `.editorconfig` is a best-effort
 * overlay, never a hard requirement.
 */
export async function loadEditorConfig(
  filePath: string,
  root: string,
): Promise<EditorConfigResolved> {
  if (!filePath || !root) return {};
  const norm = (s: string) => s.replace(/\\/g, "/").replace(/\/+$/, "");
  const fileNorm = norm(filePath);
  const rootNorm = norm(root);
  if (!fileNorm.startsWith(rootNorm + "/") && fileNorm !== rootNorm) {
    // The file lives outside the workspace root — don't walk past root.
    return {};
  }

  const base = basename(filePath);
  // Walk dirs from the file's directory up to (and including) the root.
  // We collect parsed files closest-first so we can iterate ancestor-
  // first when merging (closer-to-file overrides ancestor).
  const dirs: string[] = [];
  let cur = dirname(filePath);
  // dirname() returns the input unchanged when there's no separator;
  // guard against an infinite loop in that pathological case.
  while (cur && cur.length >= rootNorm.length) {
    dirs.push(cur);
    if (norm(cur) === rootNorm) break;
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  const parsedClosestFirst: ParsedFile[] = [];
  for (const dir of dirs) {
    const path = dir.replace(/\/+$/, "") + "/.editorconfig";
    let exists = false;
    try {
      exists = await fs.exists(path);
    } catch {
      exists = false;
    }
    if (!exists) continue;
    let text = "";
    try {
      text = await fs.readFile(path);
    } catch {
      continue;
    }
    const parsed = parseEditorConfig(text);
    parsedClosestFirst.push(parsed);
    if (parsed.root) break;
  }

  // Merge ancestor → closest so that closer files (and later sections
  // within a file) take precedence — this matches the editorconfig
  // spec's "later wins" rule.
  const out: EditorConfigResolved = {};
  for (let i = parsedClosestFirst.length - 1; i >= 0; i--) {
    const file = parsedClosestFirst[i];
    for (const section of file.sections) {
      if (!section.matches(base)) continue;
      Object.assign(out, section.values);
    }
  }
  // Fill tab_width fallback per the spec: when indent_style is "tab"
  // and only indent_size is provided, tab_width defaults to indent_size.
  if (out.tab_width == null && out.indent_size != null) {
    out.tab_width = out.indent_size;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

function parseEditorConfig(text: string): ParsedFile {
  const out: ParsedFile = { root: false, sections: [] };
  const lines = text.split(/\r\n|\r|\n/);
  let current: ParsedSection | null = null;
  let seenSection = false;

  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith(";") || line.startsWith("#")) continue;

    if (line.startsWith("[") && line.endsWith("]")) {
      const pattern = line.slice(1, -1).trim();
      current = {
        pattern,
        matches: compilePattern(pattern),
        values: {},
      };
      out.sections.push(current);
      seenSection = true;
      continue;
    }

    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const valueRaw = line.slice(eq + 1).trim();
    if (!key) continue;
    // Strip inline comments (editorconfig spec: `; comment` after value).
    const value = stripInlineComment(valueRaw).toLowerCase();

    if (!seenSection) {
      // Pre-section preamble: only `root = true` is meaningful here.
      if (key === "root" && parseBool(value) === true) {
        out.root = true;
      }
      continue;
    }
    if (!current) continue;

    applyKey(current.values, key, value);
  }

  return out;
}

function applyKey(
  target: EditorConfigResolved,
  key: string,
  value: string,
): void {
  switch (key) {
    case "indent_size": {
      const n = parseInt(value, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 16) {
        target.indent_size = n;
      }
      // The spec also allows `indent_size = tab`, meaning "use tab_width".
      // We model that by leaving indent_size unset; the resolved tabSize
      // will fall back to tab_width when the editor reads it.
      return;
    }
    case "tab_width": {
      const n = parseInt(value, 10);
      if (Number.isFinite(n) && n >= 1 && n <= 16) {
        target.tab_width = n;
      }
      return;
    }
    case "indent_style":
      if (value === "tab" || value === "space") {
        target.indent_style = value;
      }
      return;
    case "end_of_line":
      if (value === "lf" || value === "crlf" || value === "cr") {
        target.end_of_line = value;
      }
      return;
    case "insert_final_newline": {
      const b = parseBool(value);
      if (b != null) target.insert_final_newline = b;
      return;
    }
    case "trim_trailing_whitespace": {
      const b = parseBool(value);
      if (b != null) target.trim_trailing_whitespace = b;
      return;
    }
    default:
      return;
  }
}

function parseBool(v: string): boolean | null {
  if (v === "true") return true;
  if (v === "false") return false;
  return null;
}

function stripInlineComment(v: string): string {
  // editorconfig allows `key = value ; comment` and `key = value # comment`.
  // We don't try to honour quoted strings — the values we care about
  // never contain spaces or comment chars.
  for (let i = 0; i < v.length; i++) {
    const c = v[i];
    if (c === ";" || c === "#") return v.slice(0, i).trim();
  }
  return v;
}

// ---------------------------------------------------------------------------
// Pattern compiler
// ---------------------------------------------------------------------------
//
// We only support the subset of glob syntax that's actually common in
// real-world .editorconfig files: literals, `*`, `*.ext`, and the brace
// form `*.{ext1,ext2,ext3}`. Patterns containing `**`, `?`, `[…]`, or
// `/` are deliberately treated as no-match — applying half-baked
// matching to them would silently mis-configure files. Future versions
// can grow the grammar; for v1 the conservative default is "if we
// don't fully understand the pattern, do nothing".

function compilePattern(pattern: string): (basename: string) => boolean {
  if (!pattern) return () => false;
  // Reject patterns that reference path separators or unsupported globs.
  // These exist in some real configs but matching them properly requires
  // a full path-aware walk that's out of scope for v1.
  if (
    pattern.includes("/") ||
    pattern.includes("**") ||
    pattern.includes("?") ||
    pattern.includes("[")
  ) {
    return () => false;
  }
  let body = "";
  let i = 0;
  while (i < pattern.length) {
    const c = pattern[i];
    if (c === "*") {
      body += "[^/]*";
      i++;
      continue;
    }
    if (c === "{") {
      const close = pattern.indexOf("}", i);
      if (close < 0) {
        // Malformed brace — treat the rest as literal.
        body += escapeRegex(pattern.slice(i));
        break;
      }
      const inner = pattern.slice(i + 1, close);
      const parts = inner.split(",").map((p) => escapeRegex(p.trim()));
      body += `(?:${parts.join("|")})`;
      i = close + 1;
      continue;
    }
    body += escapeRegex(c);
    i++;
  }
  const re = new RegExp(`^${body}$`);
  return (name: string) => re.test(name);
}

function escapeRegex(s: string): string {
  return s.replace(/[.+^$()|\\]/g, "\\$&");
}
