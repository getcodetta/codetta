import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Terminal, type IDisposable, type ILink } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { pty } from "../ipc";
import { useResolvedTheme } from "../theme";
import { useStore } from "../store";
import { setEditorGoto } from "../editorState";

/**
 * Match `path:line` and `path:line:col` patterns in terminal output so the
 * user can click a compiler error / stack-trace frame / `grep -n` hit and
 * jump to the source location.
 *
 * Coverage:
 *   - Windows absolute: `C:\foo\bar.ts:12:5` / `C:/foo/bar.ts:12`
 *   - POSIX absolute:   `/home/x/file.rs:42`
 *   - POSIX relative:   `./src/foo.tsx:10:3` / `../lib/x.js:7`
 *   - Bare relative:    `src/foo.tsx:8` / `Cargo.toml:14`
 *
 * Capture groups: [1] = line, [2] = optional column. The full match is the
 * `path:line(:col)?` substring; we strip the trailing `:line(:col)?` to get
 * the path itself.
 *
 * The leading optional prefix excludes anything starting with a URL scheme
 * (the engine's longest-match would never produce one anyway because `://`
 * doesn't fit our shape, but we also reject hits whose path starts with
 * `http` defensively further below).
 */
const PATH_LINE_COL_RE =
  /(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|\/)?(?:[\w.\-]+[\\/])*[\w.\-]+\.\w+:(\d+)(?::(\d+))?/g;

const xtermDark = {
  background: "#1e1e1e",
  foreground: "#d4d4d4",
  cursor: "#d4d4d4",
  cursorAccent: "#1e1e1e",
  selectionBackground: "#264f78",
  selectionForeground: "#ffffff",
  selectionInactiveBackground: "#3a3d41",
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#ffffff",
};
const xtermLight = {
  background: "#ffffff",
  foreground: "#1f1f1f",
  cursor: "#1f1f1f",
  cursorAccent: "#ffffff",
  selectionBackground: "#add6ff",
  selectionForeground: "#000000",
  selectionInactiveBackground: "#e5ebf1",
  black: "#000000",
  red: "#cd3131",
  green: "#107c10",
  yellow: "#795e26",
  blue: "#0451a5",
  magenta: "#bc05bc",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#7a7a7a",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#8a6f1a",
  brightBlue: "#0451a5",
  brightMagenta: "#bc05bc",
  brightCyan: "#0598bc",
  brightWhite: "#3b3b3b",
};

interface Props {
  termId: string;
  cwd: string;
  container: HTMLElement | null;
  visible: boolean;
  shellPath?: string;
  shellArgs?: string[];
  title?: string;
  /** If set, attach to an already-running PTY (survived a reload) instead of spawning. */
  ptyId?: string;
  /** Called when this terminal first acquires (or freshly re-acquires) a PTY id. */
  onPtyIdChange?: (id: string) => void;
}

export function TerminalCore({
  cwd,
  container,
  visible,
  shellPath,
  shellArgs,
  title,
  ptyId,
  onPtyIdChange,
}: Props) {
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const ptyIdRef = useRef<string | null>(null);
  const hostNodeRef = useRef<HTMLDivElement | null>(null);
  // The link provider's `provideLinks` closure runs for the lifetime of the
  // terminal — keep cwd in a ref so we always resolve relative paths against
  // the *current* workspace root if the terminal is later re-bound.
  const cwdRef = useRef(cwd);
  useEffect(() => {
    cwdRef.current = cwd;
  }, [cwd]);
  const resolvedTheme = useResolvedTheme();

  // Update xterm theme when app theme changes.
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;
    try {
      term.options.theme =
        resolvedTheme === "dark" ? xtermDark : xtermLight;
    } catch {
      /* ignore */
    }
  }, [resolvedTheme]);

  // Mount-once: create xterm + spawn PTY. Tear down on real unmount.
  useEffect(() => {
    const initialTheme =
      document.documentElement.dataset.theme === "light"
        ? xtermLight
        : xtermDark;
    const term = new Terminal({
      fontFamily: 'Cascadia Mono, Consolas, "Courier New", monospace',
      fontSize: 13,
      theme: initialTheme,
      cursorBlink: true,
      convertEol: true,
      allowProposedApi: true,
      scrollback: 5000,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    termRef.current = term;
    fitRef.current = fit;

    // Ref callbacks fire BEFORE this effect, so by the time we create
    // the Terminal here the host div may already exist. Open onto it.
    if (hostNodeRef.current) {
      try {
        term.open(hostNodeRef.current);
      } catch {
        /* ignore */
      }
      requestAnimationFrame(() => {
        try {
          if (hostNodeRef.current && hostNodeRef.current.offsetWidth > 0) {
            fit.fit();
          }
        } catch {
          /* ignore */
        }
        try {
          term.focus();
        } catch {
          /* ignore */
        }
      });
    }

    term.attachCustomKeyEventHandler((e) => {
      if (e.type !== "keydown") return true;
      const k = e.key.toLowerCase();
      if (e.ctrlKey && e.shiftKey && k === "c") {
        const sel = term.getSelection();
        if (sel) void navigator.clipboard.writeText(sel);
        return false;
      }
      if (e.ctrlKey && e.shiftKey && k === "v") {
        void navigator.clipboard.readText().then((t) => {
          if (t && ptyIdRef.current) void pty.write(ptyIdRef.current, t);
        });
        return false;
      }
      if (e.ctrlKey && !e.shiftKey && k === "c") {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel);
          term.clearSelection();
        } else if (ptyIdRef.current) {
          void pty.write(ptyIdRef.current, "\x03");
        }
        return false;
      }
      return true;
    });

    // Make `path:line[:col]` substrings clickable so the user can jump from
    // a compiler error / stack-trace frame / `grep -n` hit straight to the
    // source location in the editor. Uses xterm's built-in link provider —
    // no addon needed.
    const linkDisposable: IDisposable = term.registerLinkProvider({
      provideLinks(bufferLineNumber, callback) {
        const buf = term.buffer.active;
        // xterm hands us 1-based line numbers; the buffer API is 0-based.
        const line = buf.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        if (!text) {
          callback(undefined);
          return;
        }
        const links: ILink[] = [];
        // Reset lastIndex defensively — the regex is shared & /g.
        PATH_LINE_COL_RE.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = PATH_LINE_COL_RE.exec(text)) !== null) {
          const matchText = m[0];
          const lineNum = parseInt(m[1] ?? "0", 10);
          const colNum = m[2] ? parseInt(m[2], 10) : 1;
          if (!Number.isFinite(lineNum) || lineNum < 1) continue;
          // Strip the `:line(:col)?` suffix to recover the path itself.
          const suffixLen =
            1 + m[1]!.length + (m[2] ? 1 + m[2].length : 0);
          const pathText = matchText.slice(0, matchText.length - suffixLen);
          // Defensive: skip URLs (xterm's URL link addon isn't loaded here,
          // so this is mainly future-proofing).
          if (/^[a-z]+:\/\//i.test(pathText)) continue;
          // xterm's IBufferRange uses 1-based, inclusive cell positions on
          // the *current* buffer line. translateToString collapses double-
          // width cells, so column-from-string-index matches cell index for
          // the common case of ASCII compiler output. That's good enough
          // here — at worst the underline is slightly off for CJK runs.
          const startCol = m.index + 1;
          const endCol = m.index + matchText.length; // inclusive
          links.push({
            range: {
              start: { x: startCol, y: bufferLineNumber },
              end: { x: endCol, y: bufferLineNumber },
            },
            text: matchText,
            decorations: { underline: true, pointerCursor: true },
            activate: () => {
              void (async () => {
                const root = cwdRef.current;
                const isWindowsAbs = /^[A-Za-z]:[\\/]/.test(pathText);
                const isPosixAbs = pathText.startsWith("/");
                const abs =
                  isWindowsAbs || isPosixAbs
                    ? pathText
                    : root
                      ? // joinPath duplicated here to avoid widening this
                        // file's import surface; mirrors src/pathUtils.ts.
                        root.replace(/[\\/]+$/, "") +
                        "/" +
                        pathText.replace(/^[\\/]+/, "")
                      : null;
                if (!abs) return;
                // Find the workspace this terminal belongs to by matching
                // its cwd against loaded workspace roots. `cwd` is set by
                // WorkspaceShell to `ws.meta.root`, so the lookup is
                // unambiguous.
                const state = useStore.getState();
                const norm = (p: string) =>
                  p.replace(/\\/g, "/").replace(/\/+$/, "");
                const wsId = Object.keys(state.loaded).find(
                  (id) => norm(state.loaded[id]!.meta.root) === norm(root),
                );
                if (!wsId) return;
                try {
                  await state.openFile(wsId, abs);
                  setEditorGoto(lineNum, colNum);
                } catch {
                  // openFile already toasts / logs on read failure.
                }
              })();
            },
          });
        }
        callback(links.length > 0 ? links : undefined);
      },
    });

    let unlistenOut: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    let cancelled = false;
    let ourId: string | null = null;
    const earlyOut: Array<{ sid: string; data: string }> = [];
    let earlyExit = false;

    void (async () => {
      try {
        unlistenOut = await pty.onOutput((sid, data) => {
          if (ourId === null) {
            earlyOut.push({ sid, data });
          } else if (sid === ourId) {
            term.write(data);
          }
        });
        unlistenExit = await pty.onExit((sid) => {
          if (ourId === null) {
            if (sid) earlyExit = true;
          } else if (sid === ourId) {
            term.writeln("\r\n[process exited]");
          }
        });
        let id: string;
        let attached = false;
        if (ptyId) {
          try {
            attached = await pty.sessionExists(ptyId);
          } catch {
            attached = false;
          }
          if (cancelled) return;
        }
        if (ptyId && attached) {
          id = ptyId;
          // Replay the rolling scrollback the backend kept for us so the
          // terminal looks like it never went away.
          try {
            const buf = await pty.getBuffer(ptyId);
            if (cancelled) return;
            if (buf) term.write(buf);
          } catch {
            /* ignore */
          }
          ourId = id;
          ptyIdRef.current = id;
          // Anything that may have arrived on the live stream during the
          // scrollback fetch is almost certainly already inside scrollback;
          // discard it instead of writing duplicates.
          earlyOut.length = 0;
          earlyExit = false;
          term.writeln(
            "\r\n\x1b[2m[reattached to running shell]\x1b[22m",
          );
        } else {
          id = await pty.spawn({
            cwd,
            cols: term.cols || 80,
            rows: term.rows || 24,
            shell: shellPath,
            args: shellArgs,
            title,
          });
          if (cancelled) {
            void pty.kill(id);
            return;
          }
          onPtyIdChange?.(id);
          ourId = id;
          ptyIdRef.current = id;
          for (const ev of earlyOut) {
            if (ev.sid === id) term.write(ev.data);
          }
          earlyOut.length = 0;
          if (earlyExit) term.writeln("\r\n[process exited]");
        }

        term.onData((data) => {
          if (ptyIdRef.current) void pty.write(ptyIdRef.current, data);
        });
        term.onResize(({ cols, rows }) => {
          if (ptyIdRef.current) void pty.resize(ptyIdRef.current, cols, rows);
        });
      } catch (e) {
        try {
          term.writeln(`\r\n[failed to start shell: ${String(e)}]`);
        } catch {
          /* ignore */
        }
      }
    })();

    return () => {
      cancelled = true;
      unlistenOut?.();
      unlistenExit?.();
      try {
        linkDisposable.dispose();
      } catch {
        /* ignore */
      }
      // Intentionally NOT killing the PTY here. The store's closeTerminal
      // and closeWorkspace explicitly kill PTYs they own; everything else
      // (hot reload, page reload, terminal-tab unmount during workspace
      // switch) leaves the PTY alive so the user can re-attach to it.
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      ptyIdRef.current = null;
    };
  }, []);

  // Whenever the host node mounts (or remounts in a new portal target),
  // bind xterm to it and refit.
  const setHostRef = useCallback((node: HTMLDivElement | null) => {
    hostNodeRef.current = node;
    if (!node) return;
    const term = termRef.current;
    if (!term) return;
    try {
      term.open(node);
    } catch {
      /* ignore */
    }
    requestAnimationFrame(() => {
      try {
        if (node.offsetWidth > 0) fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      try {
        term.focus();
      } catch {
        /* ignore */
      }
    });
  }, []);

  // Track size changes on the current host.
  useEffect(() => {
    const node = hostNodeRef.current;
    if (!node) return;
    const ro = new ResizeObserver(() => {
      if (node.offsetWidth > 0 && node.offsetHeight > 0) {
        try {
          fitRef.current?.fit();
        } catch {
          /* ignore */
        }
      }
    });
    ro.observe(node);
    return () => ro.disconnect();
  }, [container]);

  // Refit + focus on visibility transitions.
  useEffect(() => {
    if (!visible) return;
    const node = hostNodeRef.current;
    if (!node) return;
    requestAnimationFrame(() => {
      try {
        if (node.offsetWidth > 0) fitRef.current?.fit();
      } catch {
        /* ignore */
      }
      try {
        termRef.current?.focus();
      } catch {
        /* ignore */
      }
    });
  }, [visible, container]);

  if (!container) return null;

  return createPortal(
    <div
      ref={setHostRef}
      className="term-host"
      style={{ display: visible ? "block" : "none" }}
      onMouseDown={() => {
        try {
          termRef.current?.focus();
        } catch {
          /* ignore */
        }
      }}
    />,
    container,
  );
}
