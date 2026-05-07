import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { matchExclusion } from "../aiPrivacy";
import { error as toastError } from "../notify";
import { getJson as lsGetJson, setJson as lsSetJson } from "../localStore";

/**
 * Per-user always-allow rules persisted in localStorage. Three kinds:
 *   - Bare tool name (e.g. "Read") — auto-allow ANY call to that tool.
 *     Bash is intentionally excluded from this path; see NEVER_BLANKET_ALLOW.
 *   - "Bash:<prefix>" — auto-allow Bash calls whose command's first
 *     whitespace-delimited token equals <prefix>. Lets the user say
 *     "I always want grep / npm / git diff to run without asking" while
 *     keeping `rm -rf` etc. behind the card.
 *   - "Ext:<.ext>:<tool>" — auto-allow file-touching tools (Edit, Write,
 *     Read, MultiEdit, NotebookEdit) when the target file's extension
 *     matches. Per-tool so "always allow .ts edits" doesn't accidentally
 *     also allow .ts writes. Stored lowercased, leading dot.
 *
 * Format: a JSON array of strings. Schema-loose for forward compat.
 */
const ALLOW_ALWAYS_KEY = "lcp.claudeCode.alwaysAllow";

/** Tools whose primary input is a file path. Used for the per-extension
 *  always-allow tier — irrelevant for tools like Bash or WebFetch. */
const PATH_TOOLS = new Set([
  "Edit",
  "MultiEdit",
  "Write",
  "Read",
  "NotebookEdit",
]);

interface ExtRule {
  ext: string; // ".ts" lowercased, leading dot
  tool: string;
}

interface AllowRules {
  /** Tools auto-allowed in full (e.g. "Read", "Edit"). */
  tools: Set<string>;
  /** Bash command-prefix tokens auto-allowed (e.g. "grep", "npm"). */
  bashPrefixes: Set<string>;
  /** Per-tool file-extension allows (e.g. Edit on .ts). */
  exts: ExtRule[];
}

function loadAllow(): AllowRules {
  const out: AllowRules = {
    tools: new Set(),
    bashPrefixes: new Set(),
    exts: [],
  };
  const arr = lsGetJson<unknown[]>(ALLOW_ALWAYS_KEY, [], Array.isArray);
  for (const v of arr) {
    if (typeof v !== "string") continue;
    if (v.startsWith("Bash:")) out.bashPrefixes.add(v.slice(5));
    else if (v.startsWith("Ext:")) {
      const rest = v.slice(4);
      const colon = rest.indexOf(":");
      if (colon < 0) continue;
      const ext = rest.slice(0, colon).toLowerCase();
      const tool = rest.slice(colon + 1);
      if (ext && tool) out.exts.push({ ext, tool });
    } else out.tools.add(v);
  }
  return out;
}

function persistAllow(rules: AllowRules): void {
  const flat = [
    ...rules.tools,
    ...[...rules.bashPrefixes].map((p) => `Bash:${p}`),
    ...rules.exts.map((r) => `Ext:${r.ext}:${r.tool}`),
  ];
  lsSetJson(ALLOW_ALWAYS_KEY, flat);
}

function pathFromInput(input: Record<string, unknown>): string | null {
  const fp = input.file_path;
  if (typeof fp === "string" && fp) return fp;
  const np = input.notebook_path;
  if (typeof np === "string" && np) return np;
  return null;
}

function extFromPath(path: string): string | null {
  const norm = path.replace(/\\/g, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0 || dot === base.length - 1) return null; // no ext or trailing dot
  return base.slice(dot).toLowerCase();
}

/** Tools we refuse to add as bare-name always-allow even if user clicks. */
const NEVER_BLANKET_ALLOW = new Set(["Bash"]);

/** First whitespace-delimited token of a Bash command. */
function bashFirstToken(cmd: string): string {
  return cmd.trim().split(/\s+/, 1)[0] ?? "";
}

interface PermissionRequest {
  request_id: string;
  tool_name: string;
  tool_input: Record<string, unknown>;
  cwd?: string | null;
  session_id?: string | null;
}

/**
 * Decide whether an incoming request should auto-resolve to allow.
 * Pure function — easy to test, no React state involvement.
 */
function shouldAutoAllow(req: PermissionRequest, rules: AllowRules): boolean {
  if (rules.tools.has(req.tool_name) && !NEVER_BLANKET_ALLOW.has(req.tool_name)) {
    return true;
  }
  if (req.tool_name === "Bash") {
    const cmd =
      typeof req.tool_input.command === "string"
        ? req.tool_input.command
        : "";
    const first = bashFirstToken(cmd);
    if (first && rules.bashPrefixes.has(first)) return true;
  }
  if (PATH_TOOLS.has(req.tool_name)) {
    const p = pathFromInput(req.tool_input);
    const ext = p ? extFromPath(p) : null;
    if (ext && rules.exts.some((r) => r.ext === ext && r.tool === req.tool_name)) {
      return true;
    }
  }
  return false;
}

/**
 * Floating modal that surfaces Claude Code's PreToolUse permission
 * requests. Two-tier always-allow:
 *   - Tool-name (Read/Edit/Write/etc.) → auto-allow on next request
 *   - Bash command prefix (grep, npm, git, …) → auto-allow that prefix
 *
 * Plus a "this session" tier that lives in memory only and resets on
 * app restart — for "I'm doing focused work, stop interrupting me"
 * without committing to a forever-allow.
 */
export function ClaudePermissionOverlay() {
  const [queue, setQueue] = useState<PermissionRequest[]>([]);

  // Persisted always-allow. Mirrored to a ref so the listener (which
  // is registered once and lives forever) can read fresh state without
  // closure-staleness.
  const [allow, setAllow] = useState<AllowRules>(() => loadAllow());
  const allowRef = useRef(allow);
  useEffect(() => {
    allowRef.current = allow;
  }, [allow]);

  // Session-only allow — in-memory, resets on app reload. Same shape
  // as persisted rules so the auto-resolve check is uniform.
  const sessionAllowRef = useRef<AllowRules>({
    tools: new Set(),
    bashPrefixes: new Set(),
    exts: [],
  });

  useEffect(() => {
    let offReq: (() => void) | undefined;
    let offCancel: (() => void) | undefined;

    void listen<PermissionRequest>("claude:permission-request", (e) => {
      const req = e.payload;
      // PRIVACY GATE — comes BEFORE always-allow rules. If the
      // requested path matches a privacy exclusion glob, deny
      // immediately and never surface the card. The agent gets a
      // denial that names the matched pattern so it can route around
      // (e.g. ask the user instead of trying again with the same path).
      if (PATH_TOOLS.has(req.tool_name)) {
        const p = pathFromInput(req.tool_input);
        const matched = p ? matchExclusion(p) : null;
        if (matched) {
          toastError(
            `🛡 AI privacy: blocked ${req.tool_name} on ${p?.split(/[\\/]/).pop()} (matches "${matched}")`,
          );
          void invoke("claude_perm_decide", {
            requestId: req.request_id,
            decision: "deny",
          }).catch((err) => console.warn("privacy-deny failed", err));
          return;
        }
      }
      // Check both the persisted rules AND the in-memory session rules.
      // Read latest via refs so we never miss a recent click.
      if (
        shouldAutoAllow(req, allowRef.current) ||
        shouldAutoAllow(req, sessionAllowRef.current)
      ) {
        void invoke("claude_perm_decide", {
          requestId: req.request_id,
          decision: "allow",
        }).catch((err) => console.warn("auto-allow failed", err));
        return;
      }
      setQueue((q) => [...q, req]);
    }).then((u) => {
      offReq = u;
    });

    void listen<string>("claude:permission-cancelled", (e) => {
      const requestId = e.payload;
      setQueue((q) => q.filter((r) => r.request_id !== requestId));
    }).then((u) => {
      offCancel = u;
    });

    return () => {
      offReq?.();
      offCancel?.();
    };
  }, []);

  if (queue.length === 0) return null;
  const req = queue[0];
  const isBash = req.tool_name === "Bash";
  const bashCmd =
    isBash && typeof req.tool_input.command === "string"
      ? req.tool_input.command
      : "";
  const bashPrefix = isBash ? bashFirstToken(bashCmd) : "";
  const canBlanketAllow = !NEVER_BLANKET_ALLOW.has(req.tool_name);
  // File-extension always-allow only makes sense for tools whose primary
  // input is a file path (Edit/Write/Read/MultiEdit/NotebookEdit).
  const fileExt = PATH_TOOLS.has(req.tool_name)
    ? (() => {
        const p = pathFromInput(req.tool_input);
        return p ? extFromPath(p) : null;
      })()
    : null;

  const respond = async (decision: "allow" | "deny") => {
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

  // Keyboard shortcuts on the active request: Esc denies, Enter allows
  // once. Lets a user blast through a series of safe prompts without
  // mousing to the button row each time. Skipped if the user is typing
  // in an input (so Enter inside the chat input still sends a message).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const isTyping =
        !!t &&
        (t.tagName === "INPUT" ||
          t.tagName === "TEXTAREA" ||
          t.isContentEditable);
      if (isTyping) return;
      if (e.key === "Escape") {
        e.preventDefault();
        void respond("deny");
      } else if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void respond("allow");
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // respond closes over req.request_id which changes between cards;
    // re-binding per card is correct.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [req.request_id]);

  const allowAlwaysTool = async () => {
    const next: AllowRules = {
      tools: new Set(allow.tools).add(req.tool_name),
      bashPrefixes: new Set(allow.bashPrefixes),
      exts: [...allow.exts],
    };
    setAllow(next);
    persistAllow(next);
    await respond("allow");
  };

  const allowAlwaysBashPrefix = async () => {
    const next: AllowRules = {
      tools: new Set(allow.tools),
      bashPrefixes: new Set(allow.bashPrefixes).add(bashPrefix),
      exts: [...allow.exts],
    };
    setAllow(next);
    persistAllow(next);
    await respond("allow");
  };

  const allowAlwaysExt = async () => {
    if (!fileExt) return;
    const exists = allow.exts.some(
      (r) => r.ext === fileExt && r.tool === req.tool_name,
    );
    const next: AllowRules = {
      tools: new Set(allow.tools),
      bashPrefixes: new Set(allow.bashPrefixes),
      exts: exists ? [...allow.exts] : [...allow.exts, { ext: fileExt, tool: req.tool_name }],
    };
    setAllow(next);
    persistAllow(next);
    await respond("allow");
  };

  // "Allow this session" — in-memory only, resets on app reload. For
  // Bash we widen to the prefix; for path-tools we widen to the exact
  // extension; for everything else we widen to the tool name. Same UX
  // promise: stop asking until the app restarts.
  const allowThisSession = async () => {
    if (isBash && bashPrefix) {
      sessionAllowRef.current.bashPrefixes.add(bashPrefix);
    } else if (fileExt) {
      sessionAllowRef.current.exts.push({ ext: fileExt, tool: req.tool_name });
    } else {
      sessionAllowRef.current.tools.add(req.tool_name);
    }
    await respond("allow");
  };

  // Renders INLINE inside the chat panel (above the input) instead of as
  // a full-window modal overlay. The user repeatedly asked for this:
  // a centered modal blocks the conversation context, makes you lose
  // your scroll position, and feels like the AI is interrupting *you*
  // rather than asking *for permission*. Inline keeps the agent's
  // last text message + the request side by side so you can see what
  // led to the ask. Mounted by AIChatPanel; App.tsx no longer renders it.
  return (
    <div className="cc-perm-inline">
      <div className="cc-perm-card">
        <PermissionCardBody req={req} />
        <div className="cc-perm-actions">
          <button
            className="cc-perm-btn cc-perm-deny"
            onClick={() => void respond("deny")}
            title="Block this tool call. The agent treats it as a failure and may try a different approach."
          >
            ✕ Deny
          </button>
          <button
            className="cc-perm-btn cc-perm-allow-session"
            onClick={() => void allowThisSession()}
            title={
              isBash && bashPrefix
                ? `Auto-allow any "${bashPrefix} ..." for the rest of this Codetta session (resets on restart).`
                : `Auto-allow ${req.tool_name} for the rest of this Codetta session (resets on restart).`
            }
          >
            ✓ Allow this session
          </button>
          {isBash && bashPrefix && (
            <button
              className="cc-perm-btn cc-perm-allow-always"
              onClick={() => void allowAlwaysBashPrefix()}
              title={`Always allow Bash commands starting with "${bashPrefix}". Persisted across restarts. Manage in Settings.`}
            >
              ✓✓ Always allow{" "}
              <code className="cc-perm-prefix">{bashPrefix}</code>
            </button>
          )}
          {fileExt && (
            <button
              className="cc-perm-btn cc-perm-allow-always"
              onClick={() => void allowAlwaysExt()}
              title={`Always allow ${req.tool_name} on ${fileExt} files. Persisted. Manage in Settings.`}
            >
              ✓✓ Always allow {req.tool_name} on{" "}
              <code className="cc-perm-prefix">{fileExt}</code>
            </button>
          )}
          {canBlanketAllow && (
            <button
              className="cc-perm-btn cc-perm-allow-always"
              onClick={() => void allowAlwaysTool()}
              title={`Always allow every ${req.tool_name} call. Persisted. Manage in Settings.`}
            >
              ✓✓ Always allow {req.tool_name}
            </button>
          )}
          <button
            className="cc-perm-btn cc-perm-allow"
            onClick={() => void respond("allow")}
            title="Run this single call. You'll be prompted again next time."
          >
            ✓ Allow once
          </button>
        </div>
        <div className="cc-perm-shortcut-hint">
          <kbd>Enter</kbd> Allow once · <kbd>Esc</kbd> Deny
          {queue.length > 1 && (
            <span className="cc-perm-queue-inline">
              {" · "}+{queue.length - 1} more pending
            </span>
          )}
        </div>
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
  if (tool === "Write") {
    const path =
      typeof input.file_path === "string" ? input.file_path : "(unknown)";
    const content = typeof input.content === "string" ? input.content : "";
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
  return (
    <pre className="cc-perm-content">{JSON.stringify(input, null, 2)}</pre>
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
