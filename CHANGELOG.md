# Changelog

All notable changes to Codetta. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.5.0] — 2026-06-11

Agent Mode — a dedicated, agent-centric workspace — plus a plugin system,
a reimagined chat, and a richer MCP browser.

### Added

- **Agent Mode** — a global view toggle (the title-bar Agent button or
  `Ctrl+Shift+A`) that swaps the editor-centric shell for an agent
  layout: a workspace-initials rail, a per-workspace sessions list, a
  conversation-first chat as the primary surface, and a Changes / Files
  context panel. Sessions, changes, and the agent task list survive the
  toggle.
- **Conversation-first chat (agent mode)** — tool calls render as
  glanceable icon chips grouped by type: exploration (reads/searches)
  collapses into one quiet chip, while edits stand out. Click a chip to
  expand its diff or output; click an edit chip to open the file. A
  foldable Reasoning block renders extended thinking inline.
- **Agent task sidebar** — TodoWrite / TaskCreate checklists surface in a
  dedicated Tasks section beside the sessions list.
- **Plugins** — add any Claude Code plugin marketplace by GitHub URL
  (the official catalog or your own repo), browse the plugins it offers,
  and install / enable / remove them. Backed by the `claude plugin` CLI.
- **Agent Customizations modal** — one tabbed home for Instructions,
  Skills, Plugins, MCP servers, Tool Access, Providers, and Privacy.
- **MCP manual add** — alongside the one-click catalog, add a server by
  stdio command, HTTP / SSE remote URL, or npm / pip / Docker package, in
  user or project scope, with search and live install state.
- **Skills** — manage `.claude/skills/<name>/SKILL.md` (project + user
  scope): list, create, and edit.
- **File popup** — clicking a file in agent mode opens it in a popup
  editor (agent mode has no editor pane).
- **GFM tables** in the markdown renderer (chat + split preview).
- **Effort / thinking badges** in the composer (Claude Code) — always
  visible, click to change.

### Changed

- **Plan-mode approval** — `ExitPlanMode` is now permission-gated and
  shows a plan-review card with the plan rendered as markdown and
  **Approve & start** / **Keep planning** actions.

### Fixed

- Duplicate tool rows and miscounted agent tasks caused by the Claude
  Code stream re-emitting some tool calls.

## [0.2.0] — 2026-05-01

The Claude Code integration overhaul. If you primarily use Claude Code
with Codetta, this is the release to install.

### Added — Claude Code

- **GUI permission cards** replace `--dangerously-skip-permissions`.
  A localhost HTTP server in Codetta accepts `PreToolUse` hook
  callbacks; an automatically-installed `.claude/settings.local.json`
  hook routes every Edit / Write / Bash / MultiEdit / NotebookEdit
  call through a real Allow / Allow always / Deny modal. Tool-specific
  previews: literal command for Bash, unified diff for Edit, full
  content for Write. Falls back to the old bypass mode only if the
  perm server can't bind. Fixes the most-complained-about gap in the
  CC ecosystem ([#8539](https://github.com/anthropics/claude-code/issues/8539)).
- **Always-allow** auto-resolves matching tools without showing the
  card. Per-user list, manageable in **Settings → Claude Code —
  Always-allow tools**. Bash is intentionally never auto-allowed.
- **Session continuity** — captures `session_id` from the stream-json
  `system/init` event and passes `--resume <id>` on every follow-up
  turn so server-side context survives. Resumed turns send only the
  latest user message instead of re-flattening the whole transcript.
- **Tool result rendering** — `tool_result` blocks (Read / Bash /
  Glob / Grep / Edit) render as collapsible cards in chat. Previously
  silently dropped.
- **Inline Edit/Write/MultiEdit diff card** in chat with file path,
  ±line stats, expandable unified diff. Errored edits get a red
  border and result line.
- **TodoWrite first-class checklist** sticky above the chat with a
  pulsing in-progress marker. Collapsible.
- **Session picker** (⟲ Sessions in chat header on Claude Code) reads
  `~/.claude/projects/<encoded-cwd>/*.jsonl`, lists sessions sorted
  newest-first with title / preview / cost / turn count / "Xh ago".
  Click resumes; full transcript is hydrated on click.
- **Branch from here** — per-user-message ⎇ button opens a new chat
  tab with the conversation up to that turn, leaves the original
  intact. Forks fresh-not-resumed (no CC session id) so the new
  branch starts a clean server-side session.
- **Timeline scrubber** — slider above the chat (visible at 4+
  messages) scrubs back through past turns, dims post-scrub messages,
  anchors a Branch button at the scrub point. The "no wrapper has
  this" feature.
- **Spend dashboard** — per-chat cumulative cost persists in the chat
  session. Footer chip shows last-turn cost / tokens / cache% /
  duration plus the running chat total and a budget bar (color-coded:
  amber 80%+, red 100%+). One-shot warning toast when crossed.
  Configurable threshold in **Settings → Claude Code — Spend budget**.
- **MCP server browser** in **Settings → Claude Code — MCP servers**.
  Lists installed MCPs from user (`~/.claude.json`) and project
  (`.mcp.json`) scopes with shadowing warning per
  [#16728](https://github.com/anthropics/claude-code/issues/16728).
  Curated catalog with one-click install per scope: filesystem, git,
  fetch, github, puppeteer, sqlite, postgres.
- **CLAUDE.md helpers** in command palette: *Init project CLAUDE.md*
  (with scaffold), *Open project CLAUDE.md*, *Open user CLAUDE.md*.
- **Cost / token usage chip** between turns shows
  `$0.0234 · 1.2k in / 567 out · cache 89% · 3.1s`.

### Fixed — Claude Code

- Stream-json reader no longer truncates mid-event on large
  `tool_result` lines (`BufReader::lines` had an implicit cap).
  Replaced with manual `read_line` loop. Fixes
  [task-master#913](https://github.com/eyaltoledano/claude-task-master/issues/913)-class
  parse failures.
- **Idle watchdog** force-closes a hung subprocess after 120 s of
  silence with an error message instead of waiting forever for the
  terminal `result` event. Fixes
  [anthropics/claude-code#1920](https://github.com/anthropics/claude-code/issues/1920)
  hangs.
- ANSI escape codes can no longer leak into the JSON stream:
  `NO_COLOR=1`, `CLICOLOR=0`, `FORCE_COLOR=0`, `TERM=dumb` are all
  set on the spawn. `CLAUDE_SKIP_UPDATE_CHECK=1` prevents the
  auto-update banner from stealing the first line of stdout.

### Added — docs

- `docs/CLAUDE_CODE_ROADMAP.md` — the authoritative plan that drove
  this release, kept in-tree for future contributors.
- `docs/LAUNCH.md` — Show HN copy + r/* variants + Twitter/X thread +
  30-second demo recording shot list.

### Notes

- License changed to **FSL-1.1-ALv2** in v0.1.x → still the case;
  reverts to Apache 2.0 two years after each release date per the
  Functional Source License.
- Cumulative chat cost is only populated for Claude Code right now
  (other providers don't emit it via stream-json). API-billed users
  benefit most; subscription (Pro / Max) users will see `$0.0000`
  because Anthropic doesn't bill via `cost_usd` for those plans.

## [0.1.1] — 2026-04-30

### Fixed
- npm CLI wrapper renamed to `bin/cli.cjs` so `"type": "module"` in
  `package.json` doesn't break the friendly install pointer when run
  via `npx codetta`.

## [0.1.0] — 2026-04-30

### Added
- First public release. Tauri 2 + React + Monaco + xterm desktop
  editor.
- Multi-workspace tabs with per-project state (open files, layout,
  terminals).
- Multi-terminal support with **pop-out windows** — drag any terminal
  into its own OS window, redock with one click. PTY survives the
  move.
- Drag-and-drop tab splits — drop a tab onto an edge to split the
  pane horizontally or vertically.
- Integrated git: branch picker, source-control panel, line-level
  gutter markers, diff viewer.
- AI panel with **bring-your-own-model** providers: Anthropic,
  OpenAI, local Ollama, Claude Code CLI.
- Native Windows installer (NSIS / MSI) plus portable `codetta.exe`.
- Cross-platform release pipeline (macOS .dmg + Linux .AppImage / .deb)
  via the same tag-push workflow.
