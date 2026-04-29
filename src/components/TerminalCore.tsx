import { useCallback, useEffect, useRef } from "react";
import { createPortal } from "react-dom";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { pty } from "../ipc";
import { useResolvedTheme } from "../theme";

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
