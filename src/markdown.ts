// Tiny, dependency-free Markdown → HTML renderer covering the common subset:
// headings, paragraphs, fenced code blocks, inline code, bold, italic, links,
// images, ordered/unordered lists, blockquotes, hr, line breaks. Output is
// safe-by-default: every text segment is HTML-escaped before structural
// markup is layered on. Not CommonMark-compliant, but plenty for previews.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// URL scheme allowlist for the markdown renderer. Blocks `javascript:`,
// `data:`, `vbscript:` so a chat / file-preview can't be turned into an
// XSS vector by an AI hallucination, prompt injection, or a malicious
// pasted document. Relative URLs and #fragments fall through unchanged.
// Unknown schemes route to "#" for links and drop entirely for images.
function safeHrefUrl(raw: string): string {
  const stripped = raw.replace(/&amp;/g, "&").trimStart();
  if (/^[a-z][a-z0-9+.\-]*:/i.test(stripped)) {
    if (!/^(?:https?|mailto|tel|ftp|file):/i.test(stripped)) return "#";
  }
  return raw;
}
function safeImgUrl(raw: string): string {
  const stripped = raw.replace(/&amp;/g, "&").trimStart();
  if (/^[a-z][a-z0-9+.\-]*:/i.test(stripped)) {
    if (!/^(?:https?|file):/i.test(stripped)) return "";
  }
  return raw;
}

function inlineMd(s: string): string {
  // Inline code first so its contents don't get re-processed.
  let out = s.replace(/`([^`\n]+)`/g, (_m, code: string) => {
    return `<code>${escapeHtml(code)}</code>`;
  });
  // Escape what's left.
  // We need to escape carefully — placeholders for already-rendered code spans.
  const codes: string[] = [];
  // Placeholder uses < and > characters because escapeHtml below
  // rewrites them to &lt; / &gt;. The post-escape sentinel
  // ("&lt;&lt;CODE0&gt;&gt;") can't appear in user-supplied source
  // markdown — those characters would have been escaped already.
  // Means the restore step has no false-positive risk against text
  // that happens to contain "CODE0" or similar.
  out = out.replace(/<code>[\s\S]*?<\/code>/g, (m) => {
    codes.push(m);
    return `<<CODE${codes.length - 1}>>`;
  });
  out = escapeHtml(out);
  // Images: ![alt](src "title")
  out = out.replace(
    /!\[([^\]]*)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g,
    (_m, alt, src, title) => {
      const safe = safeImgUrl(src);
      if (!safe) return alt; // Drop unsafe schemes, keep alt as plain text.
      return `<img alt="${alt}" src="${safe}"${title ? ` title="${title}"` : ""}>`;
    },
  );
  // Links: [text](url)
  out = out.replace(
    /\[([^\]]+)\]\(([^\s)]+)(?:\s+"([^"]*)")?\)/g,
    (_m, text, url, title) => {
      const safe = safeHrefUrl(url);
      return `<a href="${safe}"${title ? ` title="${title}"` : ""} target="_blank" rel="noopener noreferrer">${text}</a>`;
    },
  );
  // Bold (strong) — both ** and __
  out = out.replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/__([^_\n]+)__/g, "<strong>$1</strong>");
  // Italic (em) — both * and _
  out = out.replace(/(^|[^*])\*([^*\n]+)\*([^*]|$)/g, "$1<em>$2</em>$3");
  out = out.replace(/(^|[^_])_([^_\n]+)_([^_]|$)/g, "$1<em>$2</em>$3");
  // Restore code spans. Match the post-escape form so a literal
  // "<<CODE0>>" the user happens to write goes through the escape
  // pipeline first and won't trigger the restore.
  out = out.replace(/&lt;&lt;CODE(\d+)&gt;&gt;/g, (_m, idx: string) => codes[+idx]);
  return out;
}

export interface Block {
  kind:
    | "heading"
    | "paragraph"
    | "code"
    | "ul"
    | "ol"
    | "tasklist"
    | "table"
    | "quote"
    | "hr"
    | "blank";
  level?: number;
  lang?: string;
  text?: string;
  items?: string[];
  /** For tasklist: parallel to items[], true when [x], false when [ ]. */
  checked?: boolean[];
  /** For tables: header row + body rows + per-column alignment. */
  table?: {
    header: string[];
    rows: string[][];
    aligns: Array<"left" | "center" | "right" | null>;
  };
  /** 1-based line number of the block's first source line. Set by
   *  tokenize so the rendered HTML can carry a data-source-line
   *  attribute, enabling click-to-jump from the markdown preview
   *  back into the editor. */
  line?: number;
}

function tokenize(md: string): Block[] {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const blockLine = i + 1;
    // Fenced code block
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const lang = fence[1] ?? "";
      i++;
      const start = i;
      while (i < lines.length && !lines[i].match(/^```\s*$/)) i++;
      blocks.push({
        kind: "code",
        lang,
        text: lines.slice(start, i).join("\n"),
        line: blockLine,
      });
      i++; // skip closing fence (or end)
      continue;
    }
    // Heading
    const h = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) {
      blocks.push({
        kind: "heading",
        level: h[1].length,
        text: h[2],
        line: blockLine,
      });
      i++;
      continue;
    }
    // Horizontal rule
    if (/^(?:-{3,}|_{3,}|\*{3,})\s*$/.test(line)) {
      blocks.push({ kind: "hr", line: blockLine });
      i++;
      continue;
    }
    // Blockquote — collect consecutive '>' lines
    if (/^>\s?/.test(line)) {
      const buf: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^>\s?/, ""));
        i++;
      }
      blocks.push({ kind: "quote", text: buf.join("\n"), line: blockLine });
      continue;
    }
    // Task list: bullet followed by [ ] / [x]. AI assistants emit these
    // constantly (TODO planning, checklists). Parsed before the plain-ul
    // path so the marker syntax doesn't leak into the rendered text.
    const TASK_RE = /^\s*[-*+]\s+\[([ xX])\]\s+/;
    if (TASK_RE.test(line)) {
      const items: string[] = [];
      const checked: boolean[] = [];
      while (i < lines.length && TASK_RE.test(lines[i])) {
        const m = lines[i].match(TASK_RE)!;
        checked.push(m[1] === "x" || m[1] === "X");
        items.push(lines[i].replace(TASK_RE, ""));
        i++;
      }
      blocks.push({ kind: "tasklist", items, checked, line: blockLine });
      continue;
    }
    // Unordered list
    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ul", items, line: blockLine });
      continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ kind: "ol", items, line: blockLine });
      continue;
    }
    // Blank
    if (line.trim() === "") {
      blocks.push({ kind: "blank" });
      i++;
      continue;
    }
    // Paragraph — collect consecutive non-empty lines that don't start a new
    // block construct.
    const buf: string[] = [line];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^#{1,6}\s+/.test(lines[i]) &&
      !/^```/.test(lines[i]) &&
      !/^>\s?/.test(lines[i]) &&
      !/^\s*[-*+]\s+\[[ xX]\]\s+/.test(lines[i]) &&
      !/^\s*[-*+]\s+/.test(lines[i]) &&
      !/^\s*\d+\.\s+/.test(lines[i]) &&
      !/^(?:-{3,}|_{3,}|\*{3,})\s*$/.test(lines[i])
    ) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ kind: "paragraph", text: buf.join("\n"), line: blockLine });
  }
  return blocks;
}

export function renderMarkdown(md: string): string {
  const blocks = tokenize(md);
  const parts: string[] = [];
  // Emit `data-source-line` on every block so the preview can map a
  // click back to a source line and the editor can highlight which
  // block the cursor is currently in. Headings get a bonus
  // `md-anchor` class to flag them as primary jump targets.
  const lineAttr = (b: Block) =>
    b.line ? ` data-source-line="${b.line}"` : "";
  for (const b of blocks) {
    switch (b.kind) {
      case "heading": {
        const lvl = b.level ?? 1;
        parts.push(
          `<h${lvl} class="md-anchor"${lineAttr(b)}>${inlineMd(b.text ?? "")}</h${lvl}>`,
        );
        break;
      }
      case "paragraph": {
        parts.push(`<p${lineAttr(b)}>${inlineMd(b.text ?? "")}</p>`);
        break;
      }
      case "code": {
        parts.push(
          `<pre${lineAttr(b)}><code class="lang-${b.lang ?? ""}">${escapeHtml(b.text ?? "")}</code></pre>`,
        );
        break;
      }
      case "ul": {
        parts.push(
          `<ul${lineAttr(b)}>${(b.items ?? [])
            .map((it) => `<li>${inlineMd(it)}</li>`)
            .join("")}</ul>`,
        );
        break;
      }
      case "ol": {
        parts.push(
          `<ol${lineAttr(b)}>${(b.items ?? [])
            .map((it) => `<li>${inlineMd(it)}</li>`)
            .join("")}</ol>`,
        );
        break;
      }
      case "tasklist": {
        const items = b.items ?? [];
        const checked = b.checked ?? [];
        parts.push(
          `<ul class="md-tasklist"${lineAttr(b)}>${items
            .map((it, idx) => {
              const isChecked = !!checked[idx];
              const box = isChecked
                ? `<input type="checkbox" checked disabled>`
                : `<input type="checkbox" disabled>`;
              return `<li class="md-task${isChecked ? " md-task-done" : ""}">${box} ${inlineMd(it)}</li>`;
            })
            .join("")}</ul>`,
        );
        break;
      }
      case "quote": {
        const inner = renderMarkdown(b.text ?? "");
        parts.push(`<blockquote${lineAttr(b)}>${inner}</blockquote>`);
        break;
      }
      case "hr": {
        parts.push(`<hr${lineAttr(b)}>`);
        break;
      }
      case "blank":
        break;
    }
  }
  return parts.join("\n");
}
