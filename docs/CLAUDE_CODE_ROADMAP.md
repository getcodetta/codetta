# Claude Code integration — roadmap

This document is the authoritative plan for upgrading Codetta's Claude
Code CLI integration. It captures both the *current* state of the
integration, the *gaps* identified through code review + community
research, and the *prioritized backlog* of work to close them. Update
this doc as items ship.

## Current integration (audit, April 2026)

We invoke Claude Code as a subprocess per chat turn:

```
claude -p \
  --output-format stream-json \
  --verbose \
  --dangerously-skip-permissions \
  [--model <id>] \
  [--resume <session-id>] \
  [cwd = workspace root]
```

The prompt is piped via stdin (sidesteps the Windows ~8191-char
command-line limit). Stream-json events are line-parsed in Rust
(`src-tauri/src/claude_code.rs`) and forwarded to the frontend
(`src/providers/claudeCode.ts`) which:

- Renders `assistant.content[].type === "text"` blocks into the chat
- Emits `tool_use` blocks as `tool_call` events (display-only — Claude
  Code runs its own internal tool loop, so we don't execute them)
- Detects model-rejection errors in stderr and rewrites them to a help
  pointer

What we already get right:

- Cross-platform spawn (handles npm `.cmd` shims on Windows, falls back
  to `cmd /c` / `sh -lc`, hardcoded fallback paths in `~/.claude/local`)
- `CREATE_NO_WINDOW` flag on Windows so no console flash
- Per-workspace cwd
- Process kill on AbortSignal
- Cached availability check (5 s TTL)

What we throw away or do badly:

- `system/init` event carries `session_id` — we ignore it. Every turn
  is a fresh session that loses prior context.
- `user.content[].type === "tool_result"` blocks (the actual output of
  Read/Bash/Glob/Edit) — entirely dropped. Users see "I'll explore" →
  silence → final answer with no visibility into what was read or run.
- `result` event carries `cost_usd`, `usage.{input,output,cache_*}_tokens`,
  `model`, `duration_ms`, `is_error` — all dropped.
- Permissions are unconditionally bypassed via
  `--dangerously-skip-permissions`. No diff preview before Edit/Write.
- The default `BufReader::lines()` line-length limit (~8 KiB on some
  Tauri configs) will explode mid-tool-result if Claude Code emits a
  large JSON event. Confirmed in the wild
  ([task-master #913](https://github.com/eyaltoledano/claude-task-master/issues/913)).
- Hung-process bug ([anthropics/claude-code #1920](https://github.com/anthropics/claude-code/issues/1920)) —
  no watchdog if the terminal `result` event never arrives.
- ANSI escape codes can leak into stream-json on terminals that
  auto-detect color. We don't pass `NO_COLOR=1`.

## Tier 1 — ship in the next 1–2 days (correctness fixes)

### 1. Session continuity (capture & `--resume`)

Currently `flattenMessages` smashes the entire chat history into a
prose string and sends it as a fresh prompt every turn. With session
resume, Claude Code re-uses its server-side context window and we pay
nothing to restate prior turns.

**Implementation:**

- `ai.ts`: extend `ChatStreamEvent` with `{ kind: "session"; id: string }`.
- `providers/types.ts`: add optional `resumeSessionId?: string` to the
  `ChatProvider.chat()` arg shape.
- `chatHistory.ts`: add `claudeSessionId?: string` to `ChatSession`,
  persist it.
- `claudeCode.ts`:
  - Parse `obj.type === "system" && obj.subtype === "init"` and emit
    `{ kind: "session", id: obj.session_id }` once per stream.
  - Accept `resumeSessionId` from chat args and pass it through to the
    Rust `claude_code_chat` invoke.
- `AIChatPanel.tsx`:
  - On `session` event, store the session ID on the active chat.
  - When sending a follow-up turn under `claude-code`, pass the stored
    session ID to `chatStream`.
- `chatStream` in `ai.ts`: accept and forward `resumeSessionId`.
- Rust side already accepts `resume_session_id` — verify wiring.

**Edge cases:**

- New chat → no session ID; Claude assigns one; we capture it.
- Switch from Ollama mid-chat to Claude Code → no session ID exists yet;
  treat as new conversation.
- "New chat" button → reset session ID to undefined.
- "Restore from history" → if the session has a stored Claude session
  ID, use it on next turn. Note: Claude Code may have GC'd the session;
  if `--resume` fails we should fall back to a fresh session and warn.

### 2. Render tool_result blocks

Currently in `claudeCode.ts:191` we have an explicit `// we don't surface
them` for tool_result blocks. This drops the most important debugging
signal Claude Code emits — what its tools actually returned.

**Implementation:**

- Extend `ChatStreamEvent` with `{ kind: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }`.
- `claudeCode.ts`: when parsing `obj.type === "user" && obj.message.content[].type === "tool_result"`, emit a `tool_result` event.
- `AIChatPanel.tsx`:
  - Pair each rendered `tool_call` with its matching `tool_result` by `tool_use_id`.
  - Render as a collapsible card: header shows tool name + args summary, body shows the result text (collapsed by default for results > 8 lines).
  - Special-case rendering for known tools:
    - **TodoWrite** → render as a checkbox list, persist as a sticky card at the top of the thread (per Shrivu Shankar's observation that this is the most informative single artifact).
    - **Edit / Write** → render as a unified diff with accept/reject controls (full inline-in-Monaco treatment is Tier 2; for now show in chat).
    - **Bash** → render command + collapsible stdout, exit-code badge.
    - **Read / Glob / Grep** → render as collapsible file path list / hit list.

### 3. Cost + token usage in the chat footer

The `result` event closes every Claude Code stream and contains:

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "duration_ms": 12345,
  "duration_api_ms": 9876,
  "num_turns": 3,
  "cost_usd": 0.0234,
  "usage": {
    "input_tokens": 1234,
    "output_tokens": 567,
    "cache_creation_input_tokens": 4321,
    "cache_read_input_tokens": 8901,
    "service_tier": "standard"
  },
  "session_id": "<uuid>",
  "model": "claude-opus-4-7"
}
```

**Implementation:**

- Extend `ChatStreamEvent` with `{ kind: "usage"; cost?: number; tokens?: { input: number; output: number; cacheRead: number; cacheCreate: number }; durationMs?: number; model?: string }`.
- `claudeCode.ts`: emit on the `result` event.
- `AIChatPanel.tsx`: add a small footer chip near the existing tps/warming indicator showing `$0.02 · 1.2k in / 567 out · 3.1s · cached 89%`. Only shown for the `claude-code` provider since other providers don't surface this.

### 4. Stream-json hardening

Two known classes of bug:

- **Truncation at line-length boundary** ([task-master #913](https://github.com/eyaltoledano/claude-task-master/issues/913))
  — `BufReader::lines()` may have an implicit cap; verify and switch to
  manual `read_until(b'\n')` with no cap if needed. Plus: parse JSON
  with `serde_json::from_str` and on failure, log + skip the line
  rather than killing the stream silently.

- **Hung process** ([claude-code #1920](https://github.com/anthropics/claude-code/issues/1920))
  — if Claude Code never emits the `result` event (it has happened),
  our reader thread blocks forever and the AbortController is the only
  way out. Add a watchdog: if no event for 90 s past the last activity,
  emit `end` and reap the child.

**Implementation:**

- Rust `claude_code.rs`:
  - Replace `for line in reader.lines()` with `loop { let mut line = String::new(); reader.read_line(&mut line)?; … }` so we can handle large lines without surprise truncation.
  - Add an `idle_timeout_secs` parameter (default 90) and use a separate `tokio::time::sleep` or `mpsc::recv_timeout` to guard against hangs.
  - On idle timeout: emit a stderr-style event explaining the hang, kill the child, emit `end`.
- Frontend: catch the new "hung" message and surface it as a chat error with a "retry" affordance.

### 5. NO_COLOR=1 for stream purity

ANSI escapes leaking into stream-json corrupts our JSON parse. Always
disable color when running in headless mode.

**Implementation:**

- Rust `claude_code.rs`: `cmd.env("NO_COLOR", "1")` before spawn.
- Also set `CLICOLOR=0` and `TERM=dumb` for belt-and-braces.

---

## Tier 2 — ship in 2–3 weeks (UX leaps)

### 6. GUI permission cards (replace `--dangerously-skip-permissions`)

The single loudest complaint in the ecosystem. Today users choose
between approving every Edit/Bash by hand in a TTY (impossible from a
GUI without a real PTY) or `--dangerously-skip-permissions` (which is
itself buggy and has wiped people's home directories per
[Wiegold blog](https://thomas-wiegold.com/blog/claude-code-dangerously-skip-permissions/)).

The official permission protocol is **not** exposed as stream events —
it blocks on stdin and waits for a TTY response. The way to surface it
in a GUI is via the **PreToolUse hook**: install a hook in
`.claude/settings.local.json` that calls back to our app, our app
renders an approval card, and the hook returns 0 (allow) or 2 (block).

**Implementation:**

- Switch our spawn args from `--dangerously-skip-permissions` to
  `--permission-mode default`.
- Rust: spin up a small HTTP server on a random localhost port at app
  start (only for hook callbacks). When a request arrives, emit an event
  to the frontend; wait synchronously for the user's decision; respond.
- Generate `.claude/settings.local.json` in the workspace on first
  Claude Code use, installing a `PreToolUse` hook that POSTs to that
  port. Add to `.gitignore` since the port changes per session.
- Frontend: reuse the existing `pendingPermission` UX pattern in
  `AIChatPanel.tsx` to render an approval card with rich detail (the
  literal command, the affected file paths, expandable diff for Edit).
  Buttons: Allow once · Allow this session · Allow always · Deny.
- Persist "always allow" decisions to user-level
  `.claude/settings.json` (allowedTools entries).

### 7. Inline diff for Edit / Write in Monaco

JetBrains' plugin is mocked for not doing this; Cursor does. We have
Monaco. When a `tool_use` for `Edit` arrives, we know the file path +
old_text + new_text — render a diff in the actual file's editor pane
with gutter add/remove markers and a small accept/reject overlay.

**Implementation:**

- New event channel from AI chat → `EditorPane.tsx` for the active file.
- On `tool_use` with `name === "Edit" || name === "Write"`, if the file
  matches an open editor pane, render the diff inline. If not open,
  open it first.
- Monaco `editor.deltaDecorations` + a temporary `IModelContentChange`
  preview, with accept/reject buttons in a `ContentWidget`.
- When the user accepts, do nothing (Claude already wrote it). When
  reject, write the original back and tell Claude (next turn) that the
  user reverted.

### 8. First-class TodoWrite UI

TodoWrite is the most informative single artifact of an agent run.
Surface it as a sticky card at the top of the chat thread, not buried
in tool results.

**Implementation:**

- `AIChatPanel.tsx`: maintain a `todos` state slice extracted from the
  latest TodoWrite tool call.
- Render above the message list with checkboxes (read-only — they
  reflect Claude's view, not user-editable yet).
- Style: tight, monospace, color-coded by status.

### 9. Session picker / browser

Read `~/.claude/projects/<encoded-cwd>/*.jsonl`, show title + last
preview + cost + timestamp, resume by click.

**Implementation:**

- Rust: new command `claude_code_list_sessions(cwd)` that:
  - Resolves the encoded path from the workspace root (Claude Code uses
    a deterministic encoding — replace `/` and `.` with `-`).
  - Reads `*.jsonl` files in that directory.
  - For each, parse first + last messages for title + preview, sum
    `cost_usd` from result events.
  - Returns `[{ id, title, preview, cost, lastTurnAt }]`.
- Frontend: a "Recent sessions" dropdown in the AI chat header. On
  selection, clear current chat, set `claudeSessionId`, run a no-op
  `--resume` invoke to bring the session back into context.

### 10. CLAUDE.md helper

Most users don't know CLAUDE.md exists. We can productize it.

**Implementation:**

- Command palette: "Codetta: Init project CLAUDE.md" — generates a
  scaffold based on `package.json` / `Cargo.toml` if present.
- Command palette: "Codetta: Edit project CLAUDE.md" — opens the file
  in a regular editor pane (create if missing).
- Command palette: "Codetta: Show merged Claude context" — invokes
  `claude /status` programmatically and shows the result.

---

## Tier 3 — the moat (pick one)

### 11. Transcript replay + branching

No wrapper does this. Claude Code persists every turn to `.jsonl` on
disk (`~/.claude/projects/<encoded-cwd>/<session-uuid>.jsonl`).
Combined with our existing `.claude/file-history/` infrastructure
(workspace state per absolute path), we have everything we need to
build a navigable, branchable timeline.

UX:

- A horizontal slider above the chat that scrubs through past turns
  in the active session.
- For each turn, show a "Fork from here" button that creates a new
  session seeded with the conversation up to that turn, lets the user
  edit the next prompt, and runs from there.
- Original branch stays untouched.

This is the killer feature that the on-disk infrastructure is begging
for. Three weeks of work, max.

### 12. MCP server browser

One-click installs for popular MCP servers (filesystem, git, fetch,
puppeteer, …) with a permission-toggle UI per server. Surface the
user-scope footgun ([#16728](https://github.com/anthropics/claude-code/issues/16728))
by showing merged sources from both `~/.claude.json` and `.mcp.json`
with the source labeled.

### 13. Live spend dashboard + soft caps

Builds on Tier 1 #3. Once we're parsing cost, a small status-bar widget
showing today's spend + a Settings option for "warn at $X/day" is half
a day of work.

---

## What NOT to chase

- **Slash commands in headless mode** — designed for interactive CLI;
  low ROI for a GUI integrator.
- **Hooks as a general user-extensibility surface** — too low-level for
  casual users; only useful as plumbing for Tier 2 #6.
- **Custom subagent UI** — most users never write one; built-ins
  (Plan / Explore) are good enough.
- **Streaming input mode** (`--input-format stream`) — solves a problem
  most users don't have; would force a stdin-pipeline rewrite.

---

## Source material

Code review:

- `src-tauri/src/claude_code.rs` — Rust subprocess + stream forwarding
- `src/providers/claudeCode.ts` — TypeScript provider, JSON parser, history flatten
- `src/components/AIChatPanel.tsx` — chat UI, tool-call rendering, permission flow

Community pain points (April 2026 research):

- [anthropics/claude-code#8539](https://github.com/anthropics/claude-code/issues/8539) — VS Code ext can't pass --dangerously-skip-permissions
- [anthropics/claude-code#43696](https://github.com/anthropics/claude-code/issues/43696) — --continue/--resume lose context
- [anthropics/claude-code#1920](https://github.com/anthropics/claude-code/issues/1920) — SDK sessions hang indefinitely waiting for result event
- [anthropics/claude-code#16728](https://github.com/anthropics/claude-code/issues/16728) — MCP user-scope footgun
- [anthropics/claude-code#24300](https://github.com/anthropics/claude-code/issues/24300) — "Closed: not planned" — Anthropic confirms they will not build a native lightweight GUI
- [eyaltoledano/claude-task-master#913](https://github.com/eyaltoledano/claude-task-master/issues/913) — JSON output truncation
- [Thomas Wiegold blog](https://thomas-wiegold.com/blog/claude-code-dangerously-skip-permissions/) — `rm -rf ~/` incident
- [Mehmet Baykar — resume sessions](https://mehmetbaykar.com/posts/resume-claude-code-sessions-after-restart/)
- [avasdream — agentic wrapper guide](https://avasdream.com/blog/claude-cli-agentic-wrapper)
- [Shrivu Shankar — every Claude Code feature](https://blog.sshh.io/p/how-i-use-every-claude-code-feature)

Official feature surface (April 2026):

- [Headless / SDK reference](https://code.claude.com/docs/en/sdk)
- [Permissions](https://code.claude.com/docs/en/permissions)
- [Hooks reference](https://code.claude.com/docs/en/hooks-guide)
- [Settings](https://code.claude.com/docs/en/settings)
- [MCP servers](https://code.claude.com/docs/en/mcp-servers)
