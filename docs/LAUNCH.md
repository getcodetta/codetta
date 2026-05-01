# Codetta v0.2.0 — launch material

Drafts to post when the v0.2.0 release is up on GitHub. Edit before
posting; these are intentionally written to be tweakable rather than
shipped verbatim.

---

## Show HN — primary draft

**Title** (HN allows 80 chars; this is 78):

```
Show HN: Codetta – a lightweight code editor that uses your Claude Pro plan
```

Alternative titles to consider, depending on the angle you want to lead with:

- `Show HN: Codetta – a 30 MB code editor with first-class Claude/OpenAI/Ollama` (BYOK angle)
- `Show HN: Codetta – Tauri code editor with GUI permissions for Claude Code` (perm-flow angle)
- `Show HN: A code editor that turns the Claude Code CLI into a native GUI` (positioning)

**Body** (HN rewards short and direct; ~250 words is the sweet spot):

```text
Codetta is a small desktop code editor I've been building on Tauri 2 +
React + Monaco. It ships in ~30 MB, has no telemetry, and treats AI as
a first-class panel — bring your own model from Anthropic, OpenAI,
local Ollama, or the Claude Code CLI.

The Claude Code option is the part I'm most happy with. If you already
pay for Claude Pro or Max, Codetta talks to Claude through the CLI so
your subscription covers usage instead of per-token API billing. The
common complaint with Claude Code in any GUI today is the
permissions UX — you either approve every Edit/Bash by hand or use
--dangerously-skip-permissions, which is itself buggy and has wiped
people's home directories. Codetta solves this by running a tiny
localhost HTTP server and installing a PreToolUse hook that calls
into the GUI; you get a real Allow / Allow always / Deny modal with
the literal command for Bash, a unified diff for Edit, etc.

Other things I think are unusual:

- Pop-out terminals — drag any terminal into its own OS window, redock
  with one click. PTY survives across the move.
- Session resume that actually shows the prior conversation — reads
  the on-disk JSONL transcript, hydrates the chat panel, then drives
  the next turn server-side via --resume.
- Branch from any past turn into a new chat tab without disturbing
  the current one.
- Cross-platform from a single tag push (Windows installers today,
  macOS dmg + Linux AppImage / deb in the same release pipeline).

MIT-flavored license (FSL-1.1-ALv2 → Apache 2.0 after 2 years).

https://codetta.dev — installer + source + docs

Happy to answer questions about the Claude Code integration, the
Tauri stack tradeoffs, or anything else.
```

**HN posting notes:**

- Post Tuesday or Wednesday morning Pacific time (highest sustained traffic).
- Reply to the first 5–10 comments fast; that's most of the rank signal.
- If anyone asks "why not just VS Code?" — the answer is bundle size
  + no-telemetry + the Claude Code permission flow. Don't be defensive.
- If anyone asks "is the Claude Pro angle official?" — link to
  https://docs.claude.com/en/docs/claude-code/sdk-headless and clarify
  that you're using the documented `claude -p` flow with `--resume`,
  same path Anthropic ships for SDK users.

---

## r/ClaudeAI / r/programming variants

Same body trimmed of the "Show HN" framing:

```
Codetta — a lightweight desktop editor that uses your Claude Pro
subscription via the Claude Code CLI

I built this to fix a few things that bugged me about wrapping Claude
Code in a GUI:

[…trim from above…]

Free, MIT-flavored, https://codetta.dev — installer for Windows,
macOS dmg + Linux AppImage in the same release pipeline.
```

r/ClaudeAI: lead with the subscription angle. r/rust: lead with the
Tauri stack. r/programming: lead with the ~30 MB / no-telemetry angle.

---

## Twitter / X thread (5 tweets)

**1/ Hook**

> A 30 MB code editor that uses your Claude Pro subscription instead
> of per-token API billing.
> 
> Codetta v0.2 is out — Tauri shell around the Claude Code CLI, with
> the permission UX that Claude Code is missing.
> 
> https://codetta.dev
> 
> [GIF: AI panel with Claude Code typing, permission card popping up,
>  Allow click, edit applied as inline diff in Monaco]

**2/ Permission flow**

> The biggest complaint with Claude Code in any GUI today: you either
> approve every tool by hand in a TTY or pass
> --dangerously-skip-permissions (which has wiped people's home dirs).
> 
> Codetta runs a localhost server + installs a PreToolUse hook. Real
> Allow/Allow always/Deny card with literal commands and diffs.

**3/ Sessions**

> Resume any past Claude Code session for this workspace. Picker reads
> ~/.claude/projects/*.jsonl, shows title + cost + "3h ago", click to
> hydrate the full transcript. Branch from any past turn into a new
> chat tab without losing the current one.
> 
> [Screenshot: Sessions dropdown + branch button]

**4/ Multi-window terminals**

> Drag any terminal into its own OS window for the second monitor,
> re-dock with one click. PTY survives across the move so your shell
> session stays intact.
> 
> [GIF: pop-out + redock]

**5/ Stack + close**

> Tauri 2 + Rust backend + React + Monaco + xterm. ~30 MB native.
> No telemetry. MIT-flavored license (FSL → Apache 2.0 after 2 years).
> 
> Source: https://github.com/getcodetta/codetta
> Download: https://codetta.dev
> 
> Built it because I wanted what I wanted. Hope you like it.

---

## 30-second demo recording — shot list

Record at 1920×1080 → export as 1280×720 GIF (smaller for HN/X) or
keep MP4 for embed. Use the dark theme; it reads better in browsers.

| Time | Shot | What's happening on screen |
|---|---|---|
| 0:00–0:02 | Codetta logo splash → workspace opens | Land on the welcome screen briefly, click a workspace tile to open `getcodetta/codetta` itself (meta) |
| 0:02–0:05 | Editor with file open + AI panel on the right | Show the panel header reading "Claude Code · default" — *user already on subscription* |
| 0:05–0:09 | Type a prompt: "audit src/components/PaneNode.tsx and suggest a refactor of the SplitPaneView" | Show the prompt going in. Model browser visible in corner. |
| 0:09–0:14 | Tool calls streaming in: `Read PaneNode.tsx`, then `Grep "SplitPaneView"`, then `TodoWrite` | The TodoWrite checklist appears at the top of the chat with 3 items. |
| 0:14–0:18 | Edit tool fires → permission card appears | Card shows file path + unified diff of the proposed change. Mouse hovers Allow. |
| 0:18–0:21 | Click Allow → diff card replaces the permission card in the chat | "+12 −4" stats visible, click to expand reveals full diff |
| 0:21–0:24 | Footer shows: `$0.0234 · 1.2k in / 567 out · cache 89% · 3.1s · chat total $0.04` | Camera lingers briefly on the spend chip |
| 0:24–0:27 | Open a terminal, drag it into a separate OS window | Pop-out window appears next to main, terminal visible in both transitions |
| 0:27–0:30 | End card | Solid background, white text: `codetta.dev · MIT · github.com/getcodetta/codetta` |

Recording tools:
- **Windows**: ScreenToGif (free, exports clean GIF + MP4)
- **macOS**: Kap or QuickTime + ffmpeg
- **Linux**: Peek or OBS

Post the MP4 (≤8 MB) to Twitter/X directly. For HN, paste the codetta.dev link — they don't render media inline so visuals only matter from the link's OG card (already wired to og-image.png).

---

## What I'd skip for v0.2.0

- Long-form blog post — wait for traffic before writing one
- Newsletter / Substack outreach — not enough audience yet to be worth the cold reach
- Hacker News on a Sunday — sustained traffic is too low
- Reddit on r/learnprogramming or r/webdev — wrong audience for the
  Claude-Pro-subscription angle (most don't have one)
- Posting to all surfaces simultaneously — give Show HN a clean run
  for 24 hours before fanning out, so any feedback shapes the rest

---

## Realistic outcome

Most Show HNs flop. The ones that take off do so because of one
specific thing: a real demo that the reader can install in two clicks.
Two things to get right:

1. **The download button must work.** Triple-check the v0.2.0 release
   has the Windows installer attached and that running it completes
   end-to-end without SmartScreen drama. If SmartScreen blocks (it
   will, because the binary isn't signed yet), add a sentence in the
   HN body: "Windows SmartScreen will warn — click 'More info → Run
   anyway'. Code signing is on the v0.3 list."
2. **The screen recording must show the permission card.** That's the
   one thing nothing else has. If the GIF only shows AI text streaming
   in, viewers think it's a Cursor clone.
