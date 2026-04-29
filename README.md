# Lite Coder Pro

A lightweight, fast desktop code editor built with **Tauri 2**, **React 19**, **Monaco Editor**, and **xterm.js**. Designed as a streamlined alternative to VS Code with built-in AI chat, multi-workspace support, and native performance.

---

## Features

### Multi-Workspace Support
- Open multiple project folders simultaneously as workspace tabs
- Switch between workspaces without losing terminals, unsaved edits, or layout state
- Per-workspace UI persistence (sidebar sections, pane splits, terminal sessions, open files)
- Recent workspaces list with quick re-open from the welcome screen or command palette
- Clone a repository from a Git URL directly from the welcome screen
- Workspace hydration with splash screen progress indicator on startup

### Monaco Code Editor
- Full Monaco Editor integration with syntax highlighting for 50+ languages
- Auto language detection from file extension
- Dirty file tracking with unsaved indicators on tabs
- Save (`Ctrl+S`) and save all (`Ctrl+Shift+S`)
- Auto-save with configurable delay (100ms–10s)
- Minimap toggle
- Word wrap toggle (`Alt+Z`)
- Configurable tab size (1–8 spaces)
- Font size zoom (`Ctrl+=` / `Ctrl+-` / `Ctrl+0`)
- Go to line (`Ctrl+G`) and go to symbol (`Ctrl+Shift+O`)
- Find and replace in file (`Ctrl+F` / `Ctrl+H`)
- Code folding (fold all, fold, unfold)
- Format document (`Ctrl+Shift+I`)
- Trim trailing whitespace and insert final newline on save
- Git diff decorations — added, modified, and deleted lines highlighted in the gutter
- Markdown preview mode for `.md` files

### Split Panes & Tab Management
- Recursive split pane system — split horizontally or vertically without limits
- Drag-and-drop tabs between panes or to split edges (left, right, top, bottom)
- Tab context menu: close, close all, close others, split pane
- Recent files switcher (`Ctrl+Tab`) with visual overlay
- Terminals can live in any pane alongside file tabs

### File Explorer
- Recursive file tree with lazy-loaded directory expansion
- Live auto-refresh via native file system watcher (200ms debounced)
- Context menu: new file, new folder, rename, delete, copy path, reveal in file manager
- Auto-expands parent directories when opening a file
- Excludes heavy directories: `node_modules`, `.git`, `target`, `dist`, `build`, `.next`, etc.

### Integrated Terminal
- Multiple terminal instances per workspace
- Terminals in the bottom panel or embedded in editor panes
- Shell selection: PowerShell 7+, Windows PowerShell, Command Prompt, Git Bash, WSL (Windows); bash, zsh, sh (Unix)
- PTY session persistence — terminals survive page reloads if the process is still alive
- 128 KiB scrollback buffer per session
- Copy/paste (`Ctrl+Shift+C/V` or `Ctrl+C/V`)
- Dark/light theme sync with the editor
- Responsive auto-resize

### Git / Source Control
- Repository detection and branch display with upstream tracking (ahead/behind)
- File status view: staged, unstaged, and untracked files with color-coded badges
- Stage, unstage, and discard changes per file
- Commit with message
- Pull, push, fetch, and init
- Branch listing and checkout
- Diff viewer — click any changed file to see a side-by-side diff modal
- Diff display for both staged and unstaged changes

### AI Chat Panel
- **Multi-provider support**: Ollama (local), OpenAI, Anthropic, and Claude Code CLI
- Model browser with curated catalog — coding, reasoning, general, and small model categories
- Ollama model pull/install directly from the UI with download progress
- Streaming responses with real-time rendering
- Chat session history with create, switch, and delete (stored in localStorage, up to 30 sessions)
- **Slash commands**: `/explain`, `/bugs`, `/refactor`, `/tests`, `/types`, `/docs`, `/summary`, `/tree`, `/file`, `/terminal`, `/new`, `/clear`
- Attach context: project file tree, specific files, or terminal output
- Tool execution: AI can read files, write/edit files, search text, and perform web searches
- Tool permission controls: allow, ask, or deny per tool category (read / write / web search)
- Code diff application — review and apply AI-suggested changes with visual confirmation
- API key management for OpenAI, Anthropic, and Claude Code in settings

### Claude Code CLI Integration
- Detects installed Claude Code CLI automatically (npm shims, `~/.claude/local`, `~/.local/bin`)
- Streams Claude output via `claude -p` with JSON event parsing
- Model selection and session resumption support
- Dedicated kill command for in-flight processes

### Command Palette
- Quick open (`Ctrl+P`) — fuzzy search files, switch workspaces, or run commands
- Command mode (`>` prefix) — browse and execute ~40 editor commands
- Search mode (`?` prefix) — full-text search across the workspace with line context
- Keyboard navigation with arrow keys and Enter

### Search & Code Intelligence
- Full-text search across all workspace files with case-sensitivity toggle
- TODO / FIXME / HACK / NOTE scanner — groups results by file with click-to-jump
- npm script discovery from `package.json` — run any script in a new terminal
- File listing up to 5,000 files with smart directory exclusions

### Customization & Settings
- **Theme**: Light, Dark, or System (auto-detect) — applied globally with CSS custom properties
- **Sidebar**: Toggle visibility, reposition left/right, drag-to-reorder sections
- **Sidebar sections**: File Explorer, Source Control, Tasks (npm scripts), TODOs, AI Chat — each collapsible
- **Editor**: Font size (8–32px), tab size, word wrap, minimap, auto-save, trim whitespace, final newline
- **AI permissions**: Per-tool allow/ask/deny for read, write, and web search
- **API keys**: Configure OpenAI, Anthropic, and Claude Code keys
- Settings modal accessible via `Ctrl+,` or status bar

### Notifications & Dialogs
- Toast notifications (info, success, warning, error) with auto-dismiss
- Native-style alert, confirm, and prompt dialogs with keyboard support
- Queue-based dialog system (one at a time)

### Status Bar
- Active workspace and file path with unsaved indicator
- Line/column display
- Language indicator
- Quick-access buttons: save, zoom, search, terminal, sidebar/panel toggles, theme cycle

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+S` | Save active file |
| `Ctrl+Shift+S` | Save all files |
| `Ctrl+P` | Quick open / command palette |
| `Ctrl+Shift+F` | Search across files |
| `Ctrl+B` | Toggle sidebar |
| `Ctrl+J` | Toggle bottom panel |
| `Ctrl+`` ` | New terminal |
| `Ctrl+G` | Go to line |
| `Ctrl+Shift+O` | Go to symbol |
| `Ctrl+Shift+E` | Show file explorer |
| `Ctrl+Shift+G` | Show source control |
| `Ctrl+Shift+T` | Show TODOs |
| `Ctrl+Shift+I` | Format document |
| `Ctrl+,` | Open settings |
| `Ctrl+=` / `Ctrl+-` / `Ctrl+0` | Zoom in / out / reset |
| `Alt+Z` | Toggle word wrap |
| `Ctrl+Tab` | Cycle recent files |
| `Ctrl+O` | Open folder |
| `Ctrl+Shift+W` | Close workspace |
| `Ctrl+R` | Reload window |
| `Ctrl+F` / `Ctrl+H` | Find / Replace in file |
| Middle-click tab | Close tab |

---

## Prerequisites (Windows)

You need a working Tauri 2 toolchain:

1. **Node.js 18+** — https://nodejs.org/
2. **Rust** — install via https://rustup.rs/ (or `winget install Rustlang.Rustup`)
3. **MSVC C++ Build Tools** — required for the Rust linker on Windows:
   ```powershell
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--passive --wait --add Microsoft.VisualStudio.Workload.VCTools --add Microsoft.VisualStudio.Component.Windows11SDK.22621"
   ```
   Or run the Visual Studio Build Tools installer manually and pick the **"Desktop development with C++"** workload.
4. **WebView2 runtime** — pre-installed on Windows 10/11.

After installing Rust and the build tools, **close and reopen PowerShell** so `cargo` and `link.exe` are on `PATH`.

---

## Run (development)

```powershell
npm install
npm run tauri dev
```

Or double-click `start.bat`.

The first `tauri dev` run compiles the entire Rust dependency tree and takes a few minutes; subsequent runs are fast.

---

## Build a real installable Windows app

```powershell
npm run tauri build
```

Or double-click [build-installer.bat](build-installer.bat).

After the build, you get **three** kinds of artifacts under `src-tauri\target\release\`:

| Artifact | Path | Use |
|---|---|---|
| Portable EXE | `lite-coder-pro.exe` | Run without installing |
| **NSIS installer** | `bundle\nsis\Lite Coder Pro_0.1.0_x64-setup.exe` | **VS Code-style installer** (recommended) |
| MSI installer | `bundle\msi\Lite Coder Pro_0.1.0_x64_en-US.msi` | Enterprise/SCCM-friendly |

Double-click the NSIS setup to install. The installer will:

- Ask whether to install for **just you** (no admin needed) or **all users** (admin required) — same as VS Code's "User Installer" vs "System Installer"
- Let you change the install directory
- Create a **Start Menu** entry under "Lite Coder Pro"
- Optionally create a **Desktop shortcut**
- Register an **Add/Remove Programs** entry with a proper uninstaller
- Download WebView2 silently if it's missing (it ships with Win 10/11 by default)

### Where things land

| | Per-user install | Per-machine install |
|---|---|---|
| Binary | `%LocalAppData%\Lite Coder Pro\` | `C:\Program Files\Lite Coder Pro\` |
| Workspace state | `%AppData%\lite-coder-pro\` | `%AppData%\lite-coder-pro\` |
| Uninstall | `Settings > Apps > Lite Coder Pro` | Same |

### Code signing (optional)

The installer is **unsigned** by default, so SmartScreen will show "Windows protected your PC" the first time it runs. Click "More info > Run anyway" to proceed. To remove the warning, sign the binary with a code-signing certificate and add `bundle.windows.signCommand` to `tauri.conf.json`.

---

## Tech Stack

| Layer | Technology |
|---|---|
| Desktop framework | Tauri 2 |
| Frontend | React 19, TypeScript |
| Code editor | Monaco Editor |
| Terminal | xterm.js with fit addon |
| State management | Zustand |
| Backend | Rust |
| PTY | portable-pty |
| File watching | notify + notify-debouncer-mini |
| AI providers | Ollama, OpenAI, Anthropic, Claude Code CLI |

---

## Project Layout

```
src/                     React frontend
  components/            UI components (~30 files)
    AIChatPanel.tsx      AI chat with multi-provider support
    ActivityBar.tsx       Left sidebar with workspace/view icons
    CommandPalette.tsx    Quick open, commands, and search
    ContextMenu.tsx       Right-click context menus
    DiffModal.tsx         Side-by-side git diff viewer
    EditorPane.tsx        Monaco editor with language detection
    FileTree.tsx          Recursive file explorer
    MarkdownPreview.tsx   Markdown-to-HTML renderer
    ModelBrowser.tsx      AI model catalog and installer
    PaneNode.tsx          Recursive split pane renderer
    SettingsModal.tsx     Editor and AI settings
    SourceControlPanel.tsx Git status, stage, commit, push
    StatusBar.tsx         Bottom bar with editor metadata
    TasksPanel.tsx        npm script runner
    TerminalCore.tsx      xterm terminal with PTY
    TodosPanel.tsx        TODO/FIXME scanner
    TopBar.tsx            Menu bar with window controls
    WorkspacePicker.tsx   Welcome screen
    WorkspaceShell.tsx    Workspace layout orchestrator
    ...
  providers/             AI provider implementations
    ollama.ts            Local model inference
    openai.ts            OpenAI GPT models
    anthropic.ts         Anthropic Claude models
    claudeCode.ts        Claude Code CLI integration
  store.ts               Zustand state (workspaces, tabs, panes, terminals)
  ipc.ts                 Typed wrappers around Tauri commands
  actions.ts             ~40 editor commands
  ai.ts                  Chat streaming API
  theme.ts               Light/Dark/System theme management
  editorState.ts         Monaco editor state tracking
  editorSettings.ts      Persistent editor preferences
  chatHistory.ts         AI chat session persistence
  modelCatalog.ts        Curated Ollama model list
  ...

src-tauri/src/           Rust backend
  lib.rs                 App setup and command registration
  fs_ops.rs              File operations (atomic writes, binary/size guards)
  pty.rs                 PTY sessions (UTF-8-safe coalesced output)
  watcher.rs             File system event debouncing
  git.rs                 Git CLI integration
  search.rs              Text search, TODO scan, package scripts
  workspace.rs           Persisted workspace index and state
  claude_code.rs         Claude Code CLI streaming integration
```

---

## License

Copyright 2026 Bishal. All rights reserved.
