import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/**
 * Per-user allowlist of tools that auto-resolve to Allow without
 * showing the permission card. Lives in localStorage so it survives
 * app restarts but doesn't sync between machines. Granularity: tool
 * name only (e.g. "Read"). Bash always gets the card — never
 * always-allowed at the tool level since the *command* is what
 * matters and we don't pattern-match args yet.
 */
const ALLOW_ALWAYS_KEY = "lcp.claudeCode.alwaysAllow";

function loadAlwaysAllow(): Set<string> {
  try {
    const raw = localStorage.getItem(ALLOW_ALWAYS_KEY);
    if (!raw) return new Set();
    const arr = JSON.parse(raw);
    return new Set(Array.isArray(arr) ? arr.filter((s) => typeof s === "string") : []);
  } catch {
    return new Set();
  }
}

function persistAlwaysAllow(set: Set<string>): void {
  try {
    localStorage.setItem(ALLOW_ALWAYS_KEY, JSON.stringify([...set]));
  } catch {
    /* localStorage full — best-effort */
  }
}

const NEVER_AUTO_ALLOW = new Set(["Bash"]);

/**
 * Floating modal that surfaces Claude Code's PreToolUse permission
 * requests as the agent runs. The Rust side hosts a localhost HTTP
 * server; the Claude CLI's PreToolUse hook (installed automatically
 * in `.claude/settings.local.json` per workspace) POSTs each tool
 * call to that server, which emits `claude:permission-request` and
 * blocks until the user clicks Allow / Deny.
 *
 * Why an app-level overlay instead of a per-chat-panel inline card?
 *   - Permission requests are blocking events from a subprocess. The
 *     user has to deal with them now, regardless of which chat panel
 *     is currently focused.
 *   - Multiple workspaces may be running Claude Code simultaneously;
 *     the cwd field on each request lets us label which workspace it
 *     came from without having to thread session IDs through panels.
 */
interface PermissionRequest {
  request_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string | null;
  session_id?: string | null;
}

export function ClaudePermissionOverlay() {
  const [queue, setQueue] = useState<PermissionRequest[]>([]);
  const [alwaysAllow, setAlwaysAllow] = useState<Set<string>>(() =>
    loadAlwaysAllow(),
  );

  // Auto-resolve helper called for every incoming request — if the
  // tool is in the always-allow set, decide immediately without ever
  // queueing the card.
  const autoResolveOrEnqueue = (req: PermissionRequest) => {
    if (
      alwaysAllow.has(req.tool_name) &&
      !NEVER_AUTO_ALLOW.has(req.tool_name)
    ) {
      void invoke("claude_perm_decide", {
        requestId: req.request_id,
        decision: "allow",
      }).catch((e) => console.warn("auto-allow failed", e));
      return;
    }
    setQueue((q) => [...q, req]);
  };

  // Use a ref pattern so the listener (registered once) sees the
  // up-to-date allowlist. Plain closure capture would freeze it.
  const allowRef = (function useRefAllow() {
    // useRef would import; reuse useState's setter pattern via a
    // small inline closure module is overkill. Instead expose
    // alwaysAllow through a stable accessor by re-deriving inside
    // the listener:
    return alwaysAllow;
  })();
  void allowRef;

  useEffect(() => {
    let off: (() => void) | undefined;
    void listen<PermissionRequest>("claude:permission-request", (e) => {
      // Re-read from localStorage on each event so updates from
      // "Allow always" propagate without reloading the listener.
      const allow = loadAlwaysAllow();
      if (allow.has(e.payload.tool_name) && !NEVER_AUTO_ALLOW.has(e.payload.tool_name)) {
        void invoke("claude_perm_decide", {
          requestId: e.payload.request_id,
          decision: "allow",
        }).catch((err) => console.warn("auto-allow failed", err));
        return;
      }
      setQueue((q) => [...q, e.payload]);
    }).then((u) => {
      off = u;
    });
    return () => off?.();
  }, []);
  void autoResolveOrEnqueue;

  if (queue.length === 0) return null;
  const req = queue[0];
  const canAlwaysAllow = !NEVER_AUTO_ALLOW.has(req.tool_name);

  const decide = async (decision: "allow" | "deny") => {
    try {
      await invoke("claude_perm_decide", {
        requestId: req.request_id,
        decision,
      });
    } catch (e) {
      console.warn("claude_perm_decide failed", e);
    }
    setQueue((q) => q.slice(1));
  };

  const allowAlways = async () => {
    const next = new Set(alwaysAllow);
    next.add(req.tool_name);
    setAlwaysAllow(next);
    persistAlwaysAllow(next);
    await decide("allow");
  };

  return (
    <div className="cc-perm-overlay">
      <div className="cc-perm-card" onClick={(e) => e.stopPropagation()}>
        <PermissionCardBody req={req} />
        <div className="cc-perm-actions">
          <button
            className="cc-perm-btn cc-perm-deny"
            onClick={() => void decide("deny")}
            title="Block this tool call. The agent treats it as a failure and may try a different approach."
          >
            ✕ Deny
          </button>
          {canAlwaysAllow && (
            <button
              className="cc-perm-btn cc-perm-allow-always"
              onClick={() => void allowAlways()}
              title={`Always allow ${req.tool_name} for this user. You can revoke from Settings.`}
            >
              ✓✓ Always allow {req.tool_name}
            </button>
          )}
          <button
            className="cc-perm-btn cc-perm-allow"
            onClick={() => void decide("allow")}
            title="Run this single call. You'll be prompted again next time."
          >
            ✓ Allow once
          </button>
        </div>
        {queue.length > 1 && (
          <div className="cc-perm-queue">
            +{queue.length - 1} more pending
          </div>
        )}
      </div>
    </div>
  );
}

function PermissionCardBody({ req }: { req: PermissionRequest }) {
  const { tool_name: tool, tool_input: input, cwd } = req;
  const wsName = cwd ? cwd.replace(/[\\/]+$/, "").split(/[\\/]/).pop() : null;

  return (
    <>
      <div className="cc-perm-head">
        <span className="cc-perm-icon">🔒</span>
        <span className="cc-perm-title">
          Claude Code wants to use <code>{tool}</code>
        </span>
        {wsName && <span className="cc-perm-ws">in {wsName}</span>}
      </div>
      <div className="cc-perm-body">
        <PermissionInputRenderer tool={tool} input={input} />
      </div>
    </>
  );
}

function PermissionInputRenderer({
  tool,
  input,
}: {
  tool: string;
  input: Record<string, unknown>;
}) {
  // Bash — show the literal command, big.
  if (tool === "Bash") {
    const cmd =
      typeof input.command === "string" ? input.command : JSON.stringify(input);
    const desc = typeof input.description === "string" ? input.description : "";
    return (
      <>
        {desc && <div className="cc-perm-desc">{desc}</div>}
        <pre className="cc-perm-cmd">{cmd}</pre>
        <div className="cc-perm-hint">
          This shell command will run in your workspace cwd. Read it
          carefully — the agent matches glob patterns loosely; "git diff *"
          can include "git diff-index".
        </div>
      </>
    );
  }
  // Edit / MultiEdit — show file path + diff hunks.
  if (tool === "Edit" || tool === "MultiEdit") {
    const path =
      typeof input.file_path === "string" ? input.file_path : "(unknown)";
    const edits = tool === "MultiEdit"
      ? Array.isArray(input.edits)
        ? (input.edits as Array<Record<string, unknown>>)
        : []
      : [
          {
            old_string: input.old_string,
            new_string: input.new_string,
          } as Record<string, unknown>,
        ];
    return (
      <>
        <div className="cc-perm-row">
          <span className="cc-perm-label">File</span>
          <code className="cc-perm-path">{path}</code>
        </div>
        <div className="cc-perm-edits">
          {edits.map((e, i) => (
            <DiffPreview
              key={i}
              oldText={typeof e.old_string === "string" ? e.old_string : ""}
              newText={typeof e.new_string === "string" ? e.new_string : ""}
            />
          ))}
        </div>
      </>
    );
  }
  // Write — show file path + new content (truncated).
  if (tool === "Write") {
    const path =
      typeof input.file_path === "string" ? input.file_path : "(unknown)";
    const content =
      typeof input.content === "string" ? input.content : "";
    const truncated = content.length > 4000;
    return (
      <>
        <div className="cc-perm-row">
          <span className="cc-perm-label">Write</span>
          <code className="cc-perm-path">{path}</code>
        </div>
        <pre className="cc-perm-content">
          {truncated ? content.slice(0, 4000) + "\n…[truncated]" : content}
        </pre>
      </>
    );
  }
  // NotebookEdit — show notebook path + cell info.
  if (tool === "NotebookEdit") {
    const path =
      typeof input.notebook_path === "string"
        ? input.notebook_path
        : "(unknown)";
    return (
      <div className="cc-perm-row">
        <span className="cc-perm-label">Notebook</span>
        <code className="cc-perm-path">{path}</code>
      </div>
    );
  }
  // Fallback — pretty-print the input as JSON.
  return (
    <pre className="cc-perm-content">
      {JSON.stringify(input, null, 2)}
    </pre>
  );
}

function DiffPreview({
  oldText,
  newText,
}: {
  oldText: string;
  newText: string;
}) {
  const oldLines = oldText ? oldText.split("\n") : [];
  const newLines = newText ? newText.split("\n") : [];
  return (
    <div className="cc-perm-diff">
      {oldLines.map((line, i) => (
        <div key={`o-${i}`} className="cc-perm-diff-line cc-perm-diff-rm">
          <span className="cc-perm-diff-mark">−</span>
          <span className="cc-perm-diff-text">{line || " "}</span>
        </div>
      ))}
      {newLines.map((line, i) => (
        <div key={`n-${i}`} className="cc-perm-diff-line cc-perm-diff-add">
          <span className="cc-perm-diff-mark">+</span>
          <span className="cc-perm-diff-text">{line || " "}</span>
        </div>
      ))}
    </div>
  );
}
