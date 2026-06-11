// Tool-call / diff / interleaved-block render helpers and the small
// presentational components that consume them. Pulled out of
// AIChatPanel.tsx so that file can shrink and so the same renderers
// can in principle be reused by future AI surfaces (compose card,
// activity log, etc.) without round-tripping through the chat panel.
//
// Everything here is pure presentational React + tiny pure functions.
// No closures over chat panel state, no IPC, no localStorage. Anything
// that needs more is still in AIChatPanel.

import { useState } from "react";
import type { ChatMessage, ToolCall } from "../ai";
import { balanceFences } from "../chatTextUtils";
import { MarkdownPreview } from "./MarkdownPreview";
import { Icon, type IconName } from "./Icon";

// ---------- Tool-name labelling ----------

// Lower-case tool names from Ollama / OpenAI / our own Codetta tools.
const TOOL_LABELS: Record<string, string> = {
  read_file: "Read",
  read: "Read",
  write_file: "Write",
  write: "Write",
  edit_file: "Edit",
  edit: "Edit",
  create_file: "Create",
  list_directory: "List",
  list_dir: "List",
  ls: "List",
  glob: "Glob",
  grep: "Grep",
  search: "Search",
  bash: "Bash",
  shell: "Bash",
  run_command: "Bash",
  run: "Bash",
  web_fetch: "Web Fetch",
  fetch: "Web Fetch",
  web_search: "Web Search",
  search_web: "Web Search",
};

// Claude Code tool names use CamelCase (Read, Edit, Bash, Glob, etc.)
// so the lowercase table above misses them entirely. These are the
// names the agent actually emits in stream-json tool_use blocks.
const CLAUDE_CODE_TOOL_LABELS: Record<string, string> = {
  Read: "Read",
  Write: "Write",
  Edit: "Edit",
  MultiEdit: "Edit",
  Bash: "Bash",
  BashOutput: "Bash output",
  KillShell: "Kill shell",
  Glob: "Glob",
  Grep: "Grep",
  WebFetch: "Web Fetch",
  WebSearch: "Web Search",
  TodoWrite: "Todos",
  NotebookEdit: "Notebook edit",
  Task: "Subagent",
  ExitPlanMode: "Exit plan mode",
};

export function friendlyToolName(name: string): string {
  if (TOOL_LABELS[name]) return TOOL_LABELS[name];
  if (CLAUDE_CODE_TOOL_LABELS[name]) return CLAUDE_CODE_TOOL_LABELS[name];
  // mcp__<server>__<tool> — strip the prefix and label by server.
  const mcp = /^mcp__([^_]+)__(.+)$/.exec(name);
  if (mcp) return `${mcp[1]} → ${mcp[2]}`;
  return name
    .replace(/[_-]+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function primaryToolDetail(args: Record<string, unknown>): string {
  // TodoWrite carries an array of {content, status} — show a "3 active,
  // 2 done" summary instead of the noisy default.
  if (Array.isArray(args.todos)) {
    const total = args.todos.length;
    const done = args.todos.filter(
      (t: unknown) =>
        t && typeof t === "object" &&
        (t as Record<string, unknown>).status === "completed",
    ).length;
    return `${done}/${total} done`;
  }
  // Bash command, truncated.
  if (typeof args.command === "string" && args.command.length > 0) {
    const cmd = args.command.replace(/\s+/g, " ").trim();
    return cmd.length > 80 ? cmd.slice(0, 80) + "…" : cmd;
  }
  for (const k of [
    "path",
    "file_path",
    "url",
    "pattern",
    "query",
    "name",
  ]) {
    const v = args[k];
    if (typeof v === "string" && v.length > 0) {
      return v.length > 200 ? v.slice(0, 200) + "…" : v;
    }
  }
  return "";
}

function resultPreview(result: string): string {
  const trimmed = result.trim();
  if (!trimmed) return "(empty)";
  const firstLine = trimmed.split("\n")[0];
  return firstLine.length > 200 ? firstLine.slice(0, 200) + "…" : firstLine;
}

// Pick the most-informative argument to show alongside the tool name
// in the running-tools status rows. Falls through a list of common arg
// names so this works for both Claude Code's tool catalog (file_path,
// command, url, …) and our own (path, query, …).
export function toolDetailFor(
  name: string,
  args: Record<string, unknown>,
): string {
  // AskUserQuestion carries its content in a nested questions array —
  // show the actual question text so the chip isn't a blank
  // "AskUserQuestion" row the user can't act on.
  if (name === "AskUserQuestion" && Array.isArray(args.questions)) {
    const q = args.questions[0] as Record<string, unknown> | undefined;
    if (q && typeof q.question === "string") return q.question.slice(0, 200);
  }
  for (const key of [
    "url",
    "path",
    "file_path",
    "notebook_path",
    "pattern",
    "query",
    "prompt",
    "command",
  ]) {
    const v = args[key];
    if (typeof v === "string" && v.length > 0) {
      return key === "command" ? v.slice(0, 200) : v;
    }
  }
  return "";
}

// Per-tool-family icon. Helps the user scan a list of 6+ in-flight
// calls without reading each name. Returns null for tools we don't
// recognise — the caller renders a small bullet placeholder instead.
function toolIconFor(name: string): IconName | null {
  switch (name) {
    case "Read":
    case "Glob":
      return "file-text";
    case "Grep":
    case "WebSearch":
      return "search";
    case "Edit":
    case "MultiEdit":
      return "edit";
    case "Write":
    case "create_file":
      return "plus";
    case "Bash":
      return "terminal";
    case "WebFetch":
      return "globe";
    case "TodoWrite":
      return "check-square";
    case "NotebookEdit":
      return "file-text";
    default:
      return null;
  }
}

// ---------- Diff extraction (pure) ----------

export interface EditDiff {
  oldText: string;
  newText: string;
}

/** Pull the file path out of an editing tool call. */
export function pathOf(call: ToolCall): string {
  const args = call.function.arguments as Record<string, unknown>;
  return (
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.path === "string" && args.path) ||
    (typeof args.notebook_path === "string" && args.notebook_path) ||
    "(unknown)"
  );
}

/** Sum +/- line counts across one tool call's diffs. */
export function diffStats(diffs: EditDiff[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;
  for (const d of diffs) {
    if (d.newText) added += d.newText.split("\n").filter((l) => l.length > 0).length;
    if (d.oldText) removed += d.oldText.split("\n").filter((l) => l.length > 0).length;
  }
  return { added, removed };
}

export function extractEditDiffs(call: ToolCall): EditDiff[] | null {
  const name = call.function.name;
  const args = call.function.arguments as Record<string, unknown>;
  // Edit (Claude Code) — single old/new pair.
  if (name === "Edit" || name === "edit_file" || name === "edit") {
    const oldText =
      typeof args.old_string === "string"
        ? args.old_string
        : typeof args.old_text === "string"
          ? args.old_text
          : "";
    const newText =
      typeof args.new_string === "string"
        ? args.new_string
        : typeof args.new_text === "string"
          ? args.new_text
          : "";
    if (!oldText && !newText) return null;
    return [{ oldText, newText }];
  }
  // MultiEdit — array of {old_string, new_string}.
  if (name === "MultiEdit") {
    const edits = Array.isArray(args.edits) ? args.edits : null;
    if (!edits) return null;
    const out: EditDiff[] = [];
    for (const e of edits) {
      if (!e || typeof e !== "object") continue;
      const eo = e as Record<string, unknown>;
      out.push({
        oldText: typeof eo.old_string === "string" ? eo.old_string : "",
        newText: typeof eo.new_string === "string" ? eo.new_string : "",
      });
    }
    return out.length > 0 ? out : null;
  }
  // Write / create_file — full new content. Render as add-only diff.
  if (name === "Write" || name === "write_file" || name === "create_file") {
    const content =
      typeof args.content === "string"
        ? args.content
        : typeof args.text === "string"
          ? args.text
          : "";
    if (!content) return null;
    return [{ oldText: "", newText: content }];
  }
  return null;
}

// ---------- Components ----------

/** Live tool list for the in-flight turn. Past a handful of rows the
 *  OLDEST finished ones collapse behind a count toggle — ten expanded
 *  Read rows were pushing the whole conversation off-screen. Running
 *  and errored rows always stay visible. */
export function RunningToolList({
  entries,
}: {
  entries: Array<{
    id?: string;
    name: string;
    detail: string;
    preview?: string;
    status?: "running" | "done" | "error";
  }>;
}) {
  const [expanded, setExpanded] = useState(false);
  const MAX_VISIBLE = 4;
  if (entries.length <= MAX_VISIBLE || expanded) {
    return (
      <>
        {entries.map((t, i) => (
          <RunningToolRow key={t.id ?? i} entry={t} />
        ))}
        {expanded && entries.length > MAX_VISIBLE && (
          <button
            className="ai-running-collapse"
            onClick={() => setExpanded(false)}
          >
            Show fewer
          </button>
        )}
      </>
    );
  }
  // Hide the oldest DONE rows until only MAX_VISIBLE remain;
  // running/error rows are never hidden.
  const hidden = new Set<number>();
  let toHide = entries.length - MAX_VISIBLE;
  for (let i = 0; i < entries.length && toHide > 0; i++) {
    if ((entries[i].status ?? "running") === "done") {
      hidden.add(i);
      toHide--;
    }
  }
  if (hidden.size === 0) {
    return (
      <>
        {entries.map((t, i) => (
          <RunningToolRow key={t.id ?? i} entry={t} />
        ))}
      </>
    );
  }
  return (
    <>
      <button
        className="ai-running-collapse"
        onClick={() => setExpanded(true)}
        title="Show all tool calls from this turn"
      >
        ✓ {hidden.size} earlier tool call{hidden.size === 1 ? "" : "s"}
      </button>
      {entries.map((t, i) =>
        hidden.has(i) ? null : <RunningToolRow key={t.id ?? i} entry={t} />,
      )}
    </>
  );
}

export function RunningToolRow({
  entry,
}: {
  entry: {
    name: string;
    detail: string;
    preview?: string;
    status?: "running" | "done" | "error";
  };
}) {
  // Compact display detail. For paths: keep the last two segments
  // ("…/projects/index.html"). For URLs: hostname + truncated path
  // ("example.com/blog/post"). Plain strings: untouched.
  const niceDetail = (() => {
    if (!entry.detail) return "";
    if (/^https?:\/\//i.test(entry.detail)) {
      try {
        const u = new URL(entry.detail);
        const path = (u.pathname + (u.search || "")).replace(/\/$/, "");
        const tail = path.length > 36 ? path.slice(0, 33) + "…" : path;
        return u.host + tail;
      } catch {
        return entry.detail;
      }
    }
    const norm = entry.detail.replace(/\\/g, "/");
    if (!norm.includes("/")) return norm;
    const parts = norm.split("/").filter(Boolean);
    if (parts.length <= 2) return norm;
    return "…/" + parts.slice(-2).join("/");
  })();
  const previewLines = entry.preview
    ? entry.preview.split("\n").slice(0, 6).join("\n").trim()
    : "";
  const previewTruncated =
    entry.preview && entry.preview.split("\n").length > 6;
  const icon = toolIconFor(entry.name);
  const status = entry.status ?? "running";
  return (
    <div className={`ai-running-row ai-running-row-${status}`}>
      <div className="ai-running-row-head">
        <span className="ai-running-row-icon" aria-hidden>
          {icon ? <Icon name={icon} size={12} /> : "•"}
        </span>
        <span className="ai-running-row-name">{entry.name}</span>
        {niceDetail && (
          <span
            className="ai-running-row-detail"
            title={entry.detail}
          >
            {niceDetail}
          </span>
        )}
        {status === "running" && (
          <span className="ai-spinner ai-spinner-sm ai-running-row-spinner" />
        )}
        {status === "done" && (
          <span className="ai-running-row-check" title="Finished">
            <Icon name="check" size={11} />
          </span>
        )}
        {status === "error" && (
          <span className="ai-running-row-x" title="Errored">
            <Icon name="x" size={11} />
          </span>
        )}
      </div>
      {previewLines && (
        <pre className="ai-running-row-preview">
          {previewLines}
          {previewTruncated ? "\n…" : ""}
        </pre>
      )}
    </div>
  );
}

/**
 * Render an assistant message in the EXACT order the provider emitted it:
 * text fragment → tool call → text fragment → tool call → … This replaces
 * the old "all text first, then all tool rows" layout that made the
 * conversation feel scrambled (the model would say "let me check X" but
 * the X tool row appeared above the sentence). Falls back silently for
 * messages with no recorded blocks log (older sessions, non-agentic
 * providers) — the parent picks the legacy renderer in that case.
 */
export function InterleavedBlocks({
  blocks,
  callsById,
  resultsById,
}: {
  blocks: NonNullable<ChatMessage["blocks"]>;
  callsById: Map<string, ToolCall>;
  resultsById: Map<string, string>;
}) {
  return (
    <>
      {blocks.map((b, i) => {
        if (b.kind === "text") {
          if (!b.text) return null;
          return (
            <MarkdownPreview
              key={`t${i}`}
              content={balanceFences(b.text)}
            />
          );
        }
        const call = callsById.get(b.callId);
        if (!call) return null;
        return (
          <div key={`c${i}`} className="ai-tcalls ai-tcalls-inline">
            <ToolCallRow
              call={call}
              result={resultsById.get(b.callId)}
            />
          </div>
        );
      })}
    </>
  );
}

export function ToolCallRow({
  call,
  result,
}: {
  call: ToolCall;
  result: string | undefined;
}) {
  // Hook before the edit-card early return — a row whose args stream in
  // can flip between the generic and diff renders across re-renders,
  // and a conditional hook would then violate React's hook ordering.
  const [expanded, setExpanded] = useState(false);
  // Edit / Write / MultiEdit get a richer view that shows the actual
  // diff inline, since the bare args summary ("file_path foo.ts") tells
  // the user nothing about *what changed*. Falls through to the generic
  // row for all other tools.
  const editDiffs = extractEditDiffs(call);
  if (editDiffs && editDiffs.length > 0) {
    return <EditDiffCard call={call} diffs={editDiffs} result={result} />;
  }
  const label = friendlyToolName(call.function.name);
  const detail = primaryToolDetail(call.function.arguments);
  const hasResult = typeof result === "string";
  return (
    <div className="ai-tcall">
      <div className="ai-tcall-head">
        <span className="ai-tcall-dot" />
        <span className="ai-tcall-name">{label}</span>
        {detail && <span className="ai-tcall-detail">{detail}</span>}
        {!hasResult && (
          <span className="ai-tcall-pending">
            <span className="ai-spinner" />
          </span>
        )}
      </div>
      {hasResult && (
        <button
          type="button"
          className={`ai-tcall-result${expanded ? " expanded" : ""}`}
          onClick={() => setExpanded((v) => !v)}
          title={expanded ? "Hide result" : "Click to expand"}
        >
          {expanded ? (
            <pre className="ai-tcall-result-body">{result}</pre>
          ) : (
            <span className="ai-tcall-result-preview">
              {resultPreview(result!)}
            </span>
          )}
        </button>
      )}
    </div>
  );
}

interface EditDiffCardProps {
  call: ToolCall;
  diffs: EditDiff[];
  result: string | undefined;
}

function EditDiffCard({ call, diffs, result }: EditDiffCardProps) {
  const [expanded, setExpanded] = useState(false);
  const args = call.function.arguments as Record<string, unknown>;
  const path =
    (typeof args.file_path === "string" && args.file_path) ||
    (typeof args.path === "string" && args.path) ||
    "(unknown file)";
  const label = friendlyToolName(call.function.name);
  const { added, removed } = diffStats(diffs);
  const isError =
    typeof result === "string" && /^Error|error:/i.test(result.trim());
  return (
    <div className={`ai-tcall ai-tcall-edit ${isError ? "errored" : ""}`}>
      <button
        type="button"
        className="ai-tcall-head ai-tcall-edit-head"
        onClick={() => setExpanded((v) => !v)}
        title={expanded ? "Hide diff" : "Show diff"}
      >
        <span className="ai-tcall-dot" />
        <span className="ai-tcall-name">{label}</span>
        <span className="ai-tcall-detail">{path}</span>
        <span className="ai-tcall-edit-stats">
          {removed > 0 && (
            <span className="ai-tcall-edit-rm">−{removed}</span>
          )}
          {added > 0 && <span className="ai-tcall-edit-add">+{added}</span>}
        </span>
        <span className="ai-tcall-caret">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="ai-tcall-edit-body">
          {diffs.map((d, i) => (
            <UnifiedDiff key={i} oldText={d.oldText} newText={d.newText} />
          ))}
          {result && (
            <div
              className={`ai-tcall-edit-result ${isError ? "errored" : "applied"}`}
            >
              <Icon name={isError ? "x" : "check"} size={11} />{" "}
              {result.split("\n")[0]}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Render two strings as a unified-diff-style block. We don't compute a
 * proper LCS — the input is already structured as "exactly this old →
 * exactly this new", so we just show old as removed lines and new as
 * added lines. Fast, deterministic, no diff algorithm dependency.
 */
export function UnifiedDiff({
  oldText,
  newText,
}: {
  oldText: string;
  newText: string;
}) {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  return (
    <div className="ai-diff">
      {oldLines.map((line, i) => (
        <div key={`o-${i}`} className="ai-diff-line ai-diff-rm">
          <span className="ai-diff-mark">−</span>
          <span className="ai-diff-text">{line || " "}</span>
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`n-${i}`} className="ai-diff-line ai-diff-add">
          <span className="ai-diff-mark">+</span>
          <span className="ai-diff-text">{line || " "}</span>
        </div>
      ))}
    </div>
  );
}
