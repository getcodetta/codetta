// Per-file symbol extractor for the Outline sidebar panel.
//
// Lives separately from src-tauri/src/search.rs's workspace-wide
// find_symbols command because the outline panel runs on the editor's
// current in-memory buffer (read from the Zustand store) — we don't
// want a round-trip to disk every time the user types a character. The
// pattern set deliberately mirrors find_symbols so "Go to Symbol"
// (palette @-mode) and the outline panel agree on what counts as a
// symbol — drift between the two would be confusing.
//
// Pure functions — no React, no IPC, no DOM. Easy to test in isolation.

export interface OutlineSymbol {
  /** 1-based line number in the file. */
  line: number;
  /** "function" / "class" / "interface" / "type" / "enum" / "fn" /
   *  "struct" / "trait" / "impl" / "def" / "func" / etc. Same vocabulary
   *  as find_symbols on the Rust side. */
  kind: string;
  name: string;
  /** Indent depth — 0 for top-level, 1 for one nesting level, etc.
   *  Naive line-leading-whitespace count divided by 2 (or 4 for Python).
   *  Good enough to render a tree-ish list without parsing the file. */
  depth: number;
}

interface PatternSet {
  /** indent unit (chars per level). 2 for TS/Rust/Go conventions, 4
   *  for Python. */
  indent: number;
  patterns: { kind: string; re: RegExp }[];
}

const TS_JS: PatternSet = {
  indent: 2,
  patterns: [
    {
      kind: "function",
      re: /^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)/,
    },
    {
      kind: "class",
      re: /^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)/,
    },
    { kind: "interface", re: /^\s*(?:export\s+)?interface\s+(\w+)/ },
    { kind: "type", re: /^\s*(?:export\s+)?type\s+(\w+)\s*=/ },
    {
      kind: "enum",
      re: /^\s*(?:export\s+(?:const\s+)?)?enum\s+(\w+)/,
    },
    {
      kind: "const",
      re: /^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]/,
    },
    // method-like: name(...) at indent depth ≥1, with a body. Skips
    // calls (no curly brace at end). Limits to within a class body
    // by accepting only when leading whitespace is non-zero.
    {
      kind: "method",
      re: /^\s+(?:public\s+|private\s+|protected\s+|static\s+|async\s+)*(\w+)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*[:{]/,
    },
  ],
};

const RUST: PatternSet = {
  indent: 4,
  patterns: [
    {
      kind: "fn",
      re: /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+(\w+)/,
    },
    {
      kind: "struct",
      re: /^\s*(?:pub(?:\([^)]+\))?\s+)?struct\s+(\w+)/,
    },
    {
      kind: "enum",
      re: /^\s*(?:pub(?:\([^)]+\))?\s+)?enum\s+(\w+)/,
    },
    {
      kind: "trait",
      re: /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:unsafe\s+)?trait\s+(\w+)/,
    },
    { kind: "impl", re: /^\s*impl(?:<[^>]+>)?\s+(?:[^{]*?\s+for\s+)?(\w+)/ },
    {
      kind: "const",
      re: /^\s*(?:pub(?:\([^)]+\))?\s+)?(?:const|static)\s+(\w+)\s*:/,
    },
    {
      kind: "type",
      re: /^\s*(?:pub(?:\([^)]+\))?\s+)?type\s+(\w+)\s*=/,
    },
  ],
};

const PYTHON: PatternSet = {
  indent: 4,
  patterns: [
    { kind: "def", re: /^\s*(?:async\s+)?def\s+(\w+)/ },
    { kind: "class", re: /^\s*class\s+(\w+)/ },
  ],
};

const GO: PatternSet = {
  indent: 1, // Go uses tabs; depth doesn't really apply, treat all top-level
  patterns: [
    { kind: "func", re: /^\s*func\s+(?:\([^)]+\)\s+)?(\w+)/ },
    { kind: "type", re: /^\s*type\s+(\w+)\s/ },
    { kind: "var", re: /^\s*(?:var|const)\s+(\w+)/ },
  ],
};

function pickSet(filePath: string): PatternSet | null {
  const lower = filePath.toLowerCase();
  if (
    lower.endsWith(".ts") ||
    lower.endsWith(".tsx") ||
    lower.endsWith(".js") ||
    lower.endsWith(".jsx") ||
    lower.endsWith(".mjs") ||
    lower.endsWith(".cjs")
  ) {
    return TS_JS;
  }
  if (lower.endsWith(".rs")) return RUST;
  if (lower.endsWith(".py") || lower.endsWith(".pyi")) return PYTHON;
  if (lower.endsWith(".go")) return GO;
  return null;
}

function isMarkdown(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mdx")
  );
}

// Markdown headings need different handling than the regex-per-line
// pattern set: depth comes from the '#' count, not leading whitespace.
// We also skip headings that sit inside a fenced code block, since '#'
// in code is rarely a real section header (e.g. shell comments,
// Python comments inside a Python tutorial).
function extractMarkdownOutline(content: string): OutlineSymbol[] {
  const out: OutlineSymbol[] = [];
  const lines = content.split("\n");
  let inFence = false;
  let fenceTick = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    // Track fenced code blocks (``` and ~~~). A fence opens on its own
    // line and closes on a matching marker; nested fences aren't a
    // thing in commonmark, so we keep this dead simple.
    if (trimmed.startsWith("```") || trimmed.startsWith("~~~")) {
      const marker = trimmed.startsWith("```") ? "```" : "~~~";
      if (!inFence) {
        inFence = true;
        fenceTick = marker;
      } else if (trimmed.startsWith(fenceTick)) {
        inFence = false;
        fenceTick = "";
      }
      continue;
    }
    if (inFence) continue;
    // ATX heading: 1–6 '#' followed by space and the heading text.
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (!m) continue;
    const depth = m[1].length - 1; // '#' = depth 0, '##' = depth 1
    const name = m[2].trim();
    if (!name) continue;
    out.push({
      line: i + 1,
      kind: `h${m[1].length}`,
      name,
      depth,
    });
  }
  return out;
}

function leadingWhitespace(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4; // treat tabs as 4 spaces
    else break;
  }
  return n;
}

/**
 * Extract symbols from a file's text body. Returns an empty list when
 * the file's extension isn't recognised — the panel renders an empty
 * state in that case rather than displaying noise. First-match-wins
 * per line so e.g. `export const Foo: Bar` doesn't fire both const +
 * type patterns.
 */
export function extractFileOutline(
  filePath: string,
  content: string,
): OutlineSymbol[] {
  if (isMarkdown(filePath)) return extractMarkdownOutline(content);
  const set = pickSet(filePath);
  if (!set) return [];
  const out: OutlineSymbol[] = [];
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { kind, re } of set.patterns) {
      const m = re.exec(line);
      if (m && m[1]) {
        const depth = Math.floor(leadingWhitespace(line) / set.indent);
        out.push({
          line: i + 1,
          kind,
          name: m[1],
          depth,
        });
        break;
      }
    }
  }
  return out;
}
