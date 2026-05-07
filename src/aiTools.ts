// Tool catalog + executor for the legacy non-agentic provider flow
// (Ollama, OpenAI, Anthropic API). The chat panel exposes these tool
// definitions to the model, runs the agent loop locally, and dispatches
// the tool calls itself — the user sees a confirm dialog for any
// destructive action (edit_file, create_file).
//
// Claude Code does NOT use this — it has its own internal tool catalog
// and runs its own agent loop. The PreToolUse hook (claude_perm.rs) is
// what gates Claude Code's tools.
//
// Pulled out of AIChatPanel because the catalog + executor is ~150
// lines of pure data + dispatch logic with no React surface — perfect
// for isolation.

import type { ToolCall, ToolDef } from "./ai";
import { confirm as dialogConfirm } from "./dialog";
import { fs, pty, search } from "./ipc";
import { useStore } from "./store";

/** Tool definitions exposed to the model. Kept narrow + read-only so the
 *  model can navigate the codebase without needing user confirmation
 *  (edit_file / create_file still go through dialogConfirm). */
export const TOOLS: ToolDef[] = [
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List relative file paths in the current workspace. Use this to discover the codebase layout.",
      parameters: {
        type: "object",
        properties: {
          max: {
            type: "number",
            description: "Max paths to return (default 200, hard cap 1000)",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the contents of a file by relative path (relative to workspace root). Returns up to 16000 chars.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path of the file to read",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_text",
      description:
        "Grep for a substring across all workspace source files. Returns up to 50 matching file:line entries with context.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Substring to search for" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_terminal",
      description:
        "Read the recent output (scrollback) of the active terminal in the workspace. Useful to see build/test output.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "web_search",
      description:
        "Search the public web via DuckDuckGo. Returns up to 10 result entries with title, snippet, and URL. Use this for documentation lookups or recent info.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_file",
      description:
        "Propose an edit to an EXISTING file. The user will see a diff and must approve before any change is applied. Provide the EXACT text to replace (must match the file character-for-character including whitespace). To insert at a unique anchor, include the anchor in old_text and the anchor + new content in new_text.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path of the file to edit",
          },
          old_text: {
            type: "string",
            description:
              "Exact text in the file to replace. Must appear exactly once.",
          },
          new_text: {
            type: "string",
            description:
              "Replacement text. Pass empty string to delete old_text.",
          },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_file",
      description:
        "Create a NEW file with the given contents. Fails if the file already exists. The user must approve before the file is created.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative path of the new file",
          },
          content: {
            type: "string",
            description: "File contents",
          },
        },
        required: ["path", "content"],
      },
    },
  },
];

async function webSearch(query: string): Promise<string> {
  try {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
    const res = await fetch(url, {
      method: "POST",
      headers: { "user-agent": "Mozilla/5.0 LiteCoderPro" },
    });
    if (!res.ok) return `Search failed: HTTP ${res.status}`;
    const html = await res.text();
    const out: string[] = [];
    const re =
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([^<]+)<\/a>[\s\S]*?<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/g;
    let m: RegExpExecArray | null;
    let n = 0;
    while ((m = re.exec(html)) !== null && n < 10) {
      const rawHref = m[1];
      // DuckDuckGo wraps results: //duckduckgo.com/l/?uddg=ENCODED_URL
      let href = rawHref;
      try {
        const u = new URL(
          rawHref.startsWith("//") ? "https:" + rawHref : rawHref,
          "https://duckduckgo.com",
        );
        const uddg = u.searchParams.get("uddg");
        if (uddg) href = decodeURIComponent(uddg);
      } catch {
        /* keep raw */
      }
      const title = m[2].replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
      const snippet = m[3]
        .replace(/<[^>]+>/g, "")
        .replace(/&amp;/g, "&")
        .replace(/&#x27;/g, "'")
        .replace(/\s+/g, " ")
        .trim();
      out.push(`${n + 1}. ${title}\n   ${href}\n   ${snippet}`);
      n++;
    }
    if (out.length === 0) return "(no results)";
    return out.join("\n\n");
  } catch (e) {
    return `Web search error: ${e}`;
  }
}

export async function executeTool(
  call: ToolCall,
  ctx: { wsId: string; root: string },
): Promise<string> {
  const name = call.function.name;
  const args = call.function.arguments;
  try {
    if (name === "list_files") {
      const max =
        typeof args.max === "number"
          ? Math.min(1000, Math.max(1, args.max))
          : 200;
      const files = await search.listFiles(ctx.root, max);
      return files.join("\n");
    }
    if (name === "read_file") {
      const rel = String(args.path ?? "");
      if (!rel) return "Error: missing 'path' argument";
      const abs =
        rel.includes(":") || rel.startsWith("/")
          ? rel
          : `${ctx.root}/${rel}`.replace(/\\/g, "/");
      const content = await fs.readFile(abs);
      return content.length > 16000
        ? content.slice(0, 16000) + "\n…[truncated]"
        : content;
    }
    if (name === "search_text") {
      const q = String(args.query ?? "");
      if (!q) return "Error: missing 'query' argument";
      const hits = await search.searchText(ctx.root, q, false, 50);
      return (
        hits
          .map((h) => `${h.path}:${h.line}: ${h.text}`)
          .join("\n") || "(no matches)"
      );
    }
    if (name === "read_terminal") {
      const wsLatest = useStore.getState().loaded[ctx.wsId];
      const terms = wsLatest ? Object.values(wsLatest.terminals) : [];
      const t = terms[terms.length - 1];
      if (!t?.ptyId) return "(no active terminal)";
      const buf = await pty.getBuffer(t.ptyId);
      return buf.length > 8000 ? buf.slice(-8000) : buf;
    }
    if (name === "web_search") {
      const q = String(args.query ?? "");
      if (!q) return "Error: missing 'query' argument";
      return await webSearch(q);
    }
    if (name === "edit_file") {
      const rel = String(args.path ?? "");
      const oldText = String(args.old_text ?? "");
      const newText = String(args.new_text ?? "");
      if (!rel) return "Error: missing 'path' argument";
      if (!oldText) return "Error: missing 'old_text' argument";
      const abs =
        rel.includes(":") || rel.startsWith("/")
          ? rel
          : `${ctx.root}/${rel}`.replace(/\\/g, "/");
      let original: string;
      try {
        original = await fs.readFile(abs);
      } catch (e) {
        return `Error: cannot read ${rel}: ${e}`;
      }
      const idx = original.indexOf(oldText);
      if (idx === -1) {
        return `Error: old_text not found in ${rel}. The text must match exactly. Try using read_file first to see the current contents.`;
      }
      const next =
        original.slice(0, idx) + newText + original.slice(idx + oldText.length);
      const ok = await dialogConfirm(
        `Apply this edit to ${rel}?\n\n--- BEFORE ---\n${oldText.slice(0, 800)}${oldText.length > 800 ? "\n…" : ""}\n\n--- AFTER ---\n${newText.slice(0, 800)}${newText.length > 800 ? "\n…" : ""}`,
        {
          title: `Edit ${rel}`,
          okLabel: "Apply",
          cancelLabel: "Reject",
        },
      );
      if (!ok) return `User rejected the edit to ${rel}.`;
      try {
        await fs.writeFile(abs, next);
        // Sync the in-memory store if this file is loaded.
        const wsState = useStore.getState().loaded[ctx.wsId];
        if (wsState?.files[abs]) {
          useStore.getState().updateFileContents(ctx.wsId, abs, next);
        }
        return `Applied edit to ${rel} (${oldText.length} chars replaced with ${newText.length}).`;
      } catch (e) {
        return `Error writing ${rel}: ${e}`;
      }
    }
    if (name === "create_file") {
      const rel = String(args.path ?? "");
      const content = String(args.content ?? "");
      if (!rel) return "Error: missing 'path' argument";
      const abs =
        rel.includes(":") || rel.startsWith("/")
          ? rel
          : `${ctx.root}/${rel}`.replace(/\\/g, "/");
      try {
        const exists = await fs.exists(abs);
        if (exists)
          return `Error: ${rel} already exists. Use edit_file instead.`;
      } catch {
        /* fall through */
      }
      const ok = await dialogConfirm(
        `Create new file ${rel}?\n\n--- CONTENT ---\n${content.slice(0, 1200)}${content.length > 1200 ? "\n…" : ""}`,
        {
          title: `Create ${rel}`,
          okLabel: "Create",
          cancelLabel: "Reject",
        },
      );
      if (!ok) return `User rejected creating ${rel}.`;
      try {
        await fs.writeFile(abs, content);
        return `Created ${rel} (${content.length} chars).`;
      } catch (e) {
        return `Error creating ${rel}: ${e}`;
      }
    }
    return `Unknown tool: ${name}`;
  } catch (e) {
    return `Error executing ${name}: ${e}`;
  }
}
