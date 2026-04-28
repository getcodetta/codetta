import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { pty } from "../ipc";

export function TerminalPane({ cwd }: { cwd: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const idRef = useRef<string | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    let unlistenOutput: (() => void) | undefined;
    let unlistenExit: (() => void) | undefined;
    let cancelled = false;

    const term = new Terminal({
      fontFamily: "Cascadia Mono, Consolas, monospace",
      fontSize: 13,
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
      },
      cursorBlink: true,
      convertEol: true,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current);
    fit.fit();
    term.focus();
    termRef.current = term;
    fitRef.current = fit;

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
          if (t && idRef.current) void pty.write(idRef.current, t);
        });
        return false;
      }
      if (e.ctrlKey && !e.shiftKey && k === "c") {
        const sel = term.getSelection();
        if (sel) {
          void navigator.clipboard.writeText(sel);
          term.clearSelection();
        } else if (idRef.current) {
          void pty.write(idRef.current, "\x03");
        }
        return false;
      }
      if (e.ctrlKey && !e.shiftKey && k === "v") {
        void navigator.clipboard.readText().then((t) => {
          if (t && idRef.current) void pty.write(idRef.current, t);
        });
        return false;
      }
      return true;
    });

    void (async () => {
      const { cols, rows } = term;
      const id = await pty.spawn({ cwd, cols, rows });
      if (cancelled) {
        await pty.kill(id);
        return;
      }
      idRef.current = id;

      unlistenOutput = await pty.onOutput((sid, data) => {
        if (sid === id) term.write(data);
      });
      unlistenExit = await pty.onExit((sid) => {
        if (sid === id) {
          term.write("\r\n[process exited]\r\n");
        }
      });

      term.onData((data) => {
        if (idRef.current) void pty.write(idRef.current, data);
      });
      term.onResize(({ cols, rows }) => {
        if (idRef.current) void pty.resize(idRef.current, cols, rows);
      });
    })();

    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {}
    });
    ro.observe(containerRef.current);

    return () => {
      cancelled = true;
      ro.disconnect();
      unlistenOutput?.();
      unlistenExit?.();
      if (idRef.current) void pty.kill(idRef.current);
      term.dispose();
    };
  }, [cwd]);

  return <div ref={containerRef} className="term-host" />;
}
