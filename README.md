# Codetta

**A lightweight desktop code editor with first-class AI. Bring your own model — Anthropic, OpenAI, Ollama, or Claude Code.**

[![npm](https://img.shields.io/npm/v/codetta.svg?label=npm&color=cb3837)](https://www.npmjs.com/package/codetta)
[![Release](https://img.shields.io/github/v/release/getcodetta/codetta?include_prereleases&label=release&color=6ea8ff)](https://github.com/getcodetta/codetta/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/getcodetta/codetta/total.svg?color=22c55e)](https://github.com/getcodetta/codetta/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8DB.svg)](https://tauri.app)
[![CI](https://img.shields.io/github/actions/workflow/status/getcodetta/codetta/release.yml?label=build)](https://github.com/getcodetta/codetta/actions)

Website · [codetta.dev](https://codetta.dev)
Issues · [github.com/getcodetta/codetta/issues](https://github.com/getcodetta/codetta/issues)

---

## What it is

Codetta is a small, fast desktop code editor that doesn't try to be VS Code. It ships in ~30 MB instead of 200+, has no telemetry, and treats AI as a first-class panel — *your* AI, with *your* keys.

**Highlights**

- **BYOK AI panel** — Anthropic Claude (API), OpenAI, local Ollama models, and the Claude Code CLI all in one chat. The Claude Code option lets you use your existing **Claude Pro / Max subscription** instead of paying API rates.
- **Multi-workspace** — open several projects side by side; each has its own isolated, persistent state (open files, terminals, layout)
- **Multi-terminal with pop-out** — drop terminals into the bottom panel, or pop them out into their own OS window and re-dock when done
- **Drag-and-drop tab splits** — drag any tab to an edge to split a pane horizontally or vertically
- **Integrated git** — branch picker, source-control panel, line-level gutter markers, diff viewer
- **Monaco editor** under the hood — same engine as VS Code, with syntax highlighting, IntelliSense (LSP-free), find/replace, formatting
- **Native Windows installer** (NSIS / MSI) — no Electron, no Node runtime required to run

---

## Install (end users)

### Windows

Download the installer from the [latest release](https://github.com/getcodetta/codetta/releases/latest):

| File | Use this if… |
|---|---|
| `Codetta_<version>_x64-setup.exe` | **Recommended** — NSIS installer, adds Start Menu entry + uninstaller |
| `Codetta_<version>_x64_en-US.msi` | You're deploying via SCCM / Intune / GPO |
| `codetta.exe` | Portable — run without installing (single executable) |

After install, launch **Codetta** from the Start Menu. The first run prompts you to open a folder.

**Locations on disk**

| Item | Path |
|---|---|
| Binary (per-user install) | `%LocalAppData%\Codetta\` |
| Binary (system install) | `C:\Program Files\Codetta\` |
| Workspace state | `%AppData%\codetta\` |
| Uninstall | Settings → Apps → Codetta |

### macOS / Linux

Coming soon. The codebase is Tauri 2 and already cross-platform — only the bundling/release pipeline is Windows-first today. Contributions welcome.

---

## Setting up AI (one-time, per provider)

Open **Settings → AI Providers** and add a key for whichever provider(s) you want.

| Provider | What you need | Cost |
|---|---|---|
| **Claude Code CLI** ⭐ | Install [Claude Code](https://docs.claude.com/en/docs/claude-code) and `claude login` | **Uses your existing Claude.ai Pro / Max subscription — no extra billing.** Or pay-per-token if you log in with an API key. |
| **Anthropic Claude (API)** | API key from [console.anthropic.com](https://console.anthropic.com/) | Pay-per-token |
| **OpenAI** | API key from [platform.openai.com](https://platform.openai.com/api-keys) | Pay-per-token |
| **Ollama** (local) | [Install Ollama](https://ollama.com/download) and `ollama pull qwen2.5-coder:7b` (or any model) | Free, local |

> 💡 **Already pay for Claude Pro or Max?** Use the **Claude Code CLI** option instead of the API. After `claude login`, Codetta talks to Claude through the CLI, which runs against your subscription (5-hour usage caps per your plan tier) rather than the metered API. For most coding work this is significantly cheaper than per-token API billing.

You can mix providers freely — switch models from the chat panel's model picker mid-conversation.

---

## Develop / build from source

### Prerequisites

| | Version | Install |
|---|---|---|
| **Node.js** | 18+ | https://nodejs.org |
| **Rust toolchain** | 1.77+ stable | https://rustup.rs |
| **Tauri prerequisites** | per-OS | https://tauri.app/start/prerequisites/ |
| **(Windows) WebView2** | Auto-installed by Edge / Tauri bootstrapper | usually already present |

After installing Rust, make sure `cargo` is on your `PATH`. On Windows:

```powershell
[Environment]::SetEnvironmentVariable("PATH", $env:PATH + ";$env:USERPROFILE\.cargo\bin", "User")
```

Then close and reopen your terminal.

### Clone and run

```bash
git clone https://github.com/getcodetta/codetta.git
cd codetta
npm install
npm run tauri dev
```

The first run pulls Rust crates and builds the Tauri shell — expect 3–10 minutes. Subsequent runs are seconds (incremental).

### Build a release installer

```bash
npm run tauri build
```

Outputs land in `src-tauri/target/release/bundle/`:

- `nsis/Codetta_<version>_x64-setup.exe` — recommended Windows installer
- `msi/Codetta_<version>_x64_en-US.msi` — enterprise MSI
- `src-tauri/target/release/codetta.exe` — portable executable

### Project layout

```
codetta/
├── src/                      # React + TypeScript frontend
│   ├── components/           # UI: editor panes, terminal, AI chat, sidebar, etc.
│   ├── providers/            # AI provider adapters (anthropic, openai, ollama, claude-code)
│   ├── store.ts              # Zustand state (workspaces, panes, files, terminals)
│   ├── actions.ts            # Command palette commands
│   └── App.tsx               # App shell + popout-window routing
├── src-tauri/                # Rust backend
│   ├── src/
│   │   ├── lib.rs            # Tauri command registration
│   │   ├── pty.rs            # PTY (terminal) backend via portable-pty
│   │   ├── git.rs            # Git operations
│   │   ├── fs_ops.rs         # File system commands
│   │   ├── search.rs         # Workspace file listing & content search
│   │   ├── watcher.rs        # File-system change watcher
│   │   ├── workspace.rs      # Persistent workspace state
│   │   └── claude_code.rs    # Claude Code CLI bridge
│   ├── capabilities/         # Tauri 2 permission capabilities
│   └── tauri.conf.json       # Bundle / window config
├── index.html                # Vite entry
└── package.json
```

### Useful scripts

| Command | What it does |
|---|---|
| `npm run dev` | Vite dev server only (no Tauri shell) |
| `npm run build` | Type-check + build the frontend (no Tauri) |
| `npm run tauri dev` | Full app with Rust backend + hot reload |
| `npm run tauri build` | Production installers |

---

## Contributing

Issues and PRs welcome at [github.com/getcodetta/codetta](https://github.com/getcodetta/codetta).

Please follow [DCO sign-off](https://developercertificate.org/) on commits (`git commit -s`) — no CLA required.

**Scope statement** — to keep Codetta lightweight and finishable, we deliberately do **not** plan to add: a full extension/plugin system, language-server protocol support, integrated debugger, telemetry, or built-in cloud sync. The goal is a fast, focused editor that does its job well.

---

## License

[MIT](LICENSE) © 2026 Codetta Maintainers
