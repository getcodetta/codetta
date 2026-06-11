// Tool-call / diff / interleaved-block render helpers and the small
// presentational components that consume them. Pulled out of
// AIChatPanel.tsx so that file can shrink and so the same renderers
// can in principle be reused by future AI surfaces (compose card,
// activity log, etc.) without round-tripping through the chat panel.
//
// Everything here is pure presentational React + tiny pure functions.
// No closures over chat panel state, no IPC, no localStorage. Anything
// that needs more is still in AIChatPanel.

import { useEffect, useState } from "react";
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
  // Claude sometimes retries AskUserQuestion after the redirect deny,
  // which would render two identical question cards back to back.
  // Keep only the LAST occurrence of each identical question set.
  const askDupSkip = new Set<number>();
  {
    const seen = new Map<string, number>();
    blocks.forEach((b, i) => {
      if (b.kind !== "tool_call") return;
      const call = callsById.get(b.callId);
      if (!call || call.function.name !== "AskUserQuestion") return;
      const sig = JSON.stringify(call.function.arguments?.questions ?? null);
      const prev = seen.get(sig);
      if (prev !== undefined) askDupSkip.add(prev);
      seen.set(sig, i);
    });
  }
  // Merge RUNS of the same read-ish tool into one grouped card: an
  // agentic burst of 8 Reads (or 6 TaskCreate/TaskUpdate calls) was
  // eight full-height rows saying almost nothing each. Mutating tools
  // (Edit/Write/Bash) stay individual — each one deserves its own row.
  const MERGEABLE = new Set([
    "Read",
    "Grep",
    "Glob",
    "ToolSearch",
    "TaskCreate",
    "TaskUpdate",
    "WebSearch",
    "WebFetch",
  ]);
  const groupAt = new Map<number, number[]>();
  const inGroup = new Set<number>();
  {
    let run: number[] = [];
    let runName: string | null = null;
    const flush = () => {
      if (run.length >= 2) {
        groupAt.set(run[0], [...run]);
        for (const k of run.slice(1)) inGroup.add(k);
      }
      run = [];
      runName = null;
    };
    blocks.forEach((b, i) => {
      if (b.kind !== "tool_call" || askDupSkip.has(i)) {
        if (b.kind !== "text" || b.text) flush();
        return;
      }
      const name = callsById.get(b.callId)?.function.name ?? "";
      if (!MERGEABLE.has(name)) {
        flush();
        return;
      }
      if (runName === name) {
        run.push(i);
      } else {
        flush();
        runName = name;
        run = [i];
      }
    });
    flush();
  }
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
        if (askDupSkip.has(i) || inGroup.has(i)) return null;
        const group = groupAt.get(i);
        if (group) {
          const calls = group
            .map((k) => {
              const blk = blocks[k];
              return blk.kind === "tool_call"
                ? { id: blk.callId, call: callsById.get(blk.callId) }
                : null;
            })
            .filter(
              (c): c is { id: string; call: ToolCall } => !!c && !!c.call,
            );
          if (calls.length === 0) return null;
          return (
            <div
              key={`g${i}`}
              className="ai-tcalls ai-tcalls-inline ai-tcall-group"
            >
              <div className="ai-tcall-group-head">
                {friendlyToolName(calls[0].call.function.name)} ×{" "}
                {calls.length}
              </div>
              {calls.map(({ id, call }) => (
                <ToolCallRow
                  key={id}
                  call={call}
                  result={resultsById.get(id)}
                />
              ))}
            </div>
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

interface AskQuestionSpec {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
}

/** Defensive parse of AskUserQuestion's tool input. */
function parseAskQuestions(args: Record<string, unknown>): AskQuestionSpec[] {
  if (!Array.isArray(args.questions)) return [];
  const out: AskQuestionSpec[] = [];
  for (const raw of args.questions) {
    if (!raw || typeof raw !== "object") continue;
    const q = raw as Record<string, unknown>;
    if (typeof q.question !== "string" || !Array.isArray(q.options)) continue;
    const options = q.options
      .map((o) => {
        if (typeof o === "string") return { label: o };
        if (o && typeof o === "object") {
          const oo = o as Record<string, unknown>;
          if (typeof oo.label === "string") {
            return {
              label: oo.label,
              description:
                typeof oo.description === "string"
                  ? oo.description
                  : undefined,
            };
          }
        }
        return null;
      })
      .filter((o): o is { label: string; description?: string } => !!o);
    if (options.length === 0) continue;
    out.push({
      question: q.question,
      header: typeof q.header === "string" ? q.header : undefined,
      multiSelect: q.multiSelect === true,
      options,
    });
  }
  return out;
}

/** Interactive question card for Claude Code's AskUserQuestion. The
 *  hook can only allow/deny (it can't feed an ANSWER back to a waiting
 *  tool call), so the flow is: the overlay denies the call telling the
 *  model the user sees clickable options and to wait; this card renders
 *  those options; a click sends the selection as the next user message,
 *  which resumes the session. Single-choice questions send on click;
 *  multi-select / multi-question cards collect then send. */
export function AskQuestionCard({
  call,
  onAnswer,
  onOther,
  onDismiss,
}: {
  call: ToolCall;
  onAnswer?: (text: string) => void;
  /** "Other…" picked — host should focus the chat input so the user
   *  types a free-form answer instead. */
  onOther?: () => void;
  /** ✕ / Esc — hide the card and let the user just keep chatting. */
  onDismiss?: () => void;
}) {
  const questions = parseAskQuestions(call.function.arguments);
  const [picked, setPicked] = useState<Map<number, Set<string>>>(new Map());
  const [activeIdx, setActiveIdx] = useState(0);
  const [sent, setSent] = useState(false);
  const interactive = !!onAnswer && !sent;

  // Esc dismisses the docked card — unless the user is typing in an
  // input (the composer's own Esc behavior wins there).
  useEffect(() => {
    if (!onDismiss || !interactive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      const t = e.target as HTMLElement | null;
      if (
        t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable)
      )
        return;
      e.preventDefault();
      onDismiss();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onDismiss, interactive]);

  if (questions.length === 0) {
    // Args still streaming in (or unexpected shape) — placeholder row.
    return (
      <div className="ai-tcall">
        <div className="ai-tcall-head">
          <span className="ai-tcall-dot" />
          <span className="ai-tcall-name">Question</span>
          <span className="ai-tcall-pending">
            <span className="ai-spinner" />
          </span>
        </div>
      </div>
    );
  }

  const answered = (i: number) => (picked.get(i)?.size ?? 0) > 0;
  const allAnswered = questions.every((_, i) => answered(i));

  const answerText = (sel: Map<number, Set<string>>) =>
    questions
      .map((q, i) => {
        const chosen = [...(sel.get(i) ?? [])];
        const prefix = q.header ?? q.question;
        return `${prefix}: ${chosen.join(", ")}`;
      })
      .join("\n");

  // Jump to the next unanswered question, wrapping; stay put when
  // everything is answered (Send is enabled by then).
  const advance = (from: number, sel: Map<number, Set<string>>) => {
    for (let step = 1; step <= questions.length; step++) {
      const idx = (from + step) % questions.length;
      if ((sel.get(idx)?.size ?? 0) === 0) {
        setActiveIdx(idx);
        return;
      }
    }
  };

  const choose = (qi: number, label: string) => {
    if (!interactive) return;
    const q = questions[qi];
    const next = new Map(picked);
    const cur = new Set(next.get(qi) ?? []);
    if (q.multiSelect) {
      if (cur.has(label)) cur.delete(label);
      else cur.add(label);
    } else {
      cur.clear();
      cur.add(label);
    }
    next.set(qi, cur);
    setPicked(next);
    if (!q.multiSelect) {
      if (questions.length === 1) {
        // Single question, single choice → no extra Send step.
        setSent(true);
        onAnswer!(answerText(next));
      } else {
        // Radio answered → flow straight to the next open question.
        advance(qi, next);
      }
    }
  };

  const needsSendButton =
    questions.length > 1 || questions.some((q) => q.multiSelect);
  const idx = Math.min(activeIdx, questions.length - 1);
  const q = questions[idx];

  return (
    <div className={`ai-ask-card ${sent ? "ai-ask-card-sent" : ""}`}>
      <div className="ai-ask-title">
        <span className="ai-ask-title-icon" aria-hidden="true">
          ?
        </span>
        {questions.length === 1
          ? "Claude needs your input"
          : `Claude needs your input — ${
              questions.filter((_, i) => answered(i)).length
            }/${questions.length} answered`}
        {onDismiss && interactive && (
          <button
            type="button"
            className="ai-ask-close"
            onClick={onDismiss}
            title="Dismiss (Esc) — you can still answer in the message box"
            aria-label="Dismiss question card"
          >
            ✕
          </button>
        )}
      </div>
      {questions.length > 1 && (
        <div className="ai-ask-tabs" role="tablist">
          {questions.map((tq, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === idx}
              className={`ai-ask-tab ${i === idx ? "active" : ""} ${
                answered(i) ? "answered" : ""
              }`}
              onClick={() => setActiveIdx(i)}
            >
              {answered(i) && <span aria-hidden="true">✓ </span>}
              {tq.header ?? `Q${i + 1}`}
            </button>
          ))}
        </div>
      )}
      <div className="ai-ask-question">
        <div className="ai-ask-qtext">
          {questions.length === 1 && q.header && (
            <span className="ai-ask-header">{q.header}</span>
          )}
          {q.question}
          {q.multiSelect && (
            <span className="ai-ask-multi">select all that apply</span>
          )}
        </div>
        <div
          className="ai-ask-options"
          role={q.multiSelect ? "group" : "radiogroup"}
        >
          {q.options.map((o) => {
            const isPicked = picked.get(idx)?.has(o.label) ?? false;
            return (
              <button
                key={o.label}
                type="button"
                role={q.multiSelect ? "checkbox" : "radio"}
                aria-checked={isPicked}
                className={`ai-ask-option ${isPicked ? "picked" : ""}`}
                disabled={!interactive}
                onClick={() => choose(idx, o.label)}
                title={o.description}
              >
                <span
                  className={`ai-ask-ind ${
                    q.multiSelect ? "ai-ask-ind-check" : "ai-ask-ind-radio"
                  } ${isPicked ? "on" : ""}`}
                  aria-hidden="true"
                />
                <span className="ai-ask-option-text">
                  <span className="ai-ask-option-label">{o.label}</span>
                  {o.description && (
                    <span className="ai-ask-option-desc">
                      {o.description}
                    </span>
                  )}
                </span>
              </button>
            );
          })}
          {interactive && onOther && (
            <button
              type="button"
              className="ai-ask-option ai-ask-option-other"
              onClick={onOther}
              title="Answer in your own words in the message box"
            >
              <span
                className={`ai-ask-ind ${
                  q.multiSelect ? "ai-ask-ind-check" : "ai-ask-ind-radio"
                }`}
                aria-hidden="true"
              />
              <span className="ai-ask-option-text">
                <span className="ai-ask-option-label">Other…</span>
              </span>
            </button>
          )}
        </div>
        {interactive &&
          q.multiSelect &&
          questions.length > 1 &&
          answered(idx) &&
          !allAnswered && (
            <button
              type="button"
              className="ai-ask-next"
              onClick={() => advance(idx, picked)}
            >
              Next question →
            </button>
          )}
      </div>
      <div className="ai-ask-foot">
        {interactive && needsSendButton && (
          <button
            type="button"
            className="ai-ask-send"
            disabled={!allAnswered}
            onClick={() => {
              setSent(true);
              onAnswer!(answerText(picked));
            }}
          >
            Send answer{questions.length > 1 ? "s" : ""}
          </button>
        )}
        {interactive && (
          <span className="ai-ask-hint">
            …or just reply in the message box below.
            {onDismiss ? " Esc to dismiss." : ""}
          </span>
        )}
        {sent && <span className="ai-ask-hint">Answer sent.</span>}
      </div>
    </div>
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
  // AskUserQuestion: a compact one-line record in the transcript. The
  // INTERACTIVE card renders docked above the composer (AIChatPanel's
  // ask-dock) while the question is pending — rendering full option
  // lists here too duplicated the whole card. The deny reason in
  // `result` is plumbing (the redirect instruction), never shown.
  if (call.function.name === "AskUserQuestion") {
    const qs = parseAskQuestions(call.function.arguments);
    const summary =
      qs.map((q) => q.header ?? q.question).join(" · ") || "question";
    return (
      <div className="ai-tcall">
        <div className="ai-tcall-head">
          <span className="ai-tcall-dot" />
          <span className="ai-tcall-name">Question</span>
          <span className="ai-tcall-detail" title={summary}>
            {summary}
          </span>
        </div>
      </div>
    );
  }
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
  // Tools like ToolSearch / TaskUpdate legitimately return no text —
  // their effect is the side channel, not the output. Rendering the
  // empty string as an expandable "(empty)" row read like a failure;
  // a quiet check says "done" instead.
  const resultIsEmpty = hasResult && result!.trim().length === 0;
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
        {resultIsEmpty && (
          <span className="ai-tcall-done" aria-hidden="true">
            ✓
          </span>
        )}
      </div>
      {hasResult && !resultIsEmpty && (
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
