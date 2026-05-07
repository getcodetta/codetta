import { useCallback, useEffect, useRef, useState } from "react";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { TerminalCore } from "./TerminalCore";
import { bootstrapTheme } from "../theme";
import { pty } from "../ipc";
import { Icon } from "./Icon";

// Apply theme as early as possible — before React renders the popout —
// so the window doesn't flash light when the user is in dark mode. The
// spawning side passes the currently-resolved theme via URL; if that's
// missing for any reason we fall back to whatever localStorage says.
(function applyInitialPopoutTheme() {
  try {
    const sp = new URLSearchParams(window.location.search);
    const t = sp.get("theme");
    if (t === "dark" || t === "light") {
      document.documentElement.dataset.theme = t;
      return;
    }
  } catch {
    /* ignore — fall through */
  }
  bootstrapTheme();
})();

interface PopoutParams {
  wsId: string;
  termId: string;
  ptyId?: string;
  cwd: string;
  shellPath?: string;
  shellArgs?: string[];
  title: string;
}

function readParams(): PopoutParams | null {
  const sp = new URLSearchParams(window.location.search);
  const wsId = sp.get("wsId");
  const termId = sp.get("termId");
  const cwd = sp.get("cwd");
  if (!wsId || !termId || !cwd) return null;
  let shellArgs: string[] | undefined;
  const argsRaw = sp.get("shellArgs");
  if (argsRaw) {
    try {
      const parsed = JSON.parse(argsRaw);
      if (Array.isArray(parsed)) {
        shellArgs = parsed.filter((a) => typeof a === "string");
      }
    } catch {
      /* ignore */
    }
  }
  return {
    wsId,
    termId,
    ptyId: sp.get("ptyId") ?? undefined,
    cwd,
    shellPath: sp.get("shellPath") ?? undefined,
    shellArgs,
    title: sp.get("title") ?? "Terminal",
  };
}

export function TerminalPopoutWindow() {
  const [params] = useState<PopoutParams | null>(() => readParams());
  const [host, setHost] = useState<HTMLDivElement | null>(null);
  // Ref callback so React re-renders TerminalCore once the host div mounts.
  const setHostRef = useCallback((node: HTMLDivElement | null) => {
    setHost(node);
  }, []);
  // Track the live PTY id so the close handler emits a payload that lets
  // the main window verify the redock event matches the right session.
  const livePtyRef = useRef<string | undefined>(params?.ptyId);

  // Subscribe to theme changes in the main window. localStorage `storage`
  // events fire across same-origin windows whenever another window writes
  // to it — that's how the user's settings change in main reaches us.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== "lcp.theme") return;
      const v = e.newValue;
      if (v === "light" || v === "dark") {
        document.documentElement.dataset.theme = v;
      } else if (v === "system" || v === null) {
        const prefersDark = window.matchMedia(
          "(prefers-color-scheme: dark)",
        ).matches;
        document.documentElement.dataset.theme = prefersDark
          ? "dark"
          : "light";
      }
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  // Mirror the OS title with the terminal name so taskbar/preview is useful.
  useEffect(() => {
    if (!params) return;
    void getCurrentWindow()
      .setTitle(`${params.title} — Codetta`)
      .catch(() => {});
  }, [params?.title]);

  // We deliberately do NOT register an onCloseRequested handler in the
  // popout. Doing so creates an infinite loop:
  //   1. Re-dock button emits popout:redock
  //   2. Main listens and calls WebviewWindow.close() on us
  //   3. close() fires tauri://close-requested in our window
  //   4. If we re-emitted popout:redock here, main would try to close us
  //      again → close-requested → emit → close → … queue saturates
  //      ("PostMessage failed; Error code 0x80070718").
  // OS-level closes (alt+F4, task manager) are still covered: the main
  // side's `tauri://destroyed` listener (set up in popOutTerminal) fires
  // when the window actually goes away and flips popped back to false.
  useEffect(() => {
    if (!params) return;
    let exitOff: (() => void) | undefined;
    const win = getCurrentWindow();

    void pty
      .onExit((sid) => {
        if (sid && sid === livePtyRef.current) {
          // PTY died — ask main to close us.
          void emit("popout:redock", {
            wsId: params.wsId,
            termId: params.termId,
            ptyId: livePtyRef.current,
          }).catch(() => {});
          // And try to close ourselves as a backup.
          void win.close().catch(() => {});
        }
      })
      .then((off) => {
        exitOff = off;
      });

    return () => {
      exitOff?.();
    };
  }, [params?.wsId, params?.termId]);

  if (!params) {
    return (
      <div className="popout-error">
        <div>Invalid pop-out parameters.</div>
      </div>
    );
  }

  const redock = () => {
    // Ask main to close us. Main calls WebviewWindow.close() from its
    // side, which is more reliable than getCurrentWindow().close() from
    // inside the popout (Tauri 2 sometimes silently drops self-closes).
    if (!params) return;
    void emit("popout:redock", {
      wsId: params.wsId,
      termId: params.termId,
      ptyId: livePtyRef.current,
    }).catch((err) => {
      console.warn("redock emit failed", err);
    });
  };

  return (
    <div className="popout-shell" role="application" aria-label={`Terminal: ${params.title}`}>
      <div className="popout-bar" data-tauri-drag-region>
        <span className="popout-bar-title">{params.title}</span>
        <span className="popout-bar-spacer" />
        <button
          type="button"
          className="popout-bar-btn"
          onClick={redock}
          title="Send this terminal back to the main window"
          aria-label="Re-dock terminal to main window"
        >
          <Icon name="rotate-ccw" size={12} />
          <span>Re-dock</span>
        </button>
      </div>
      <div ref={setHostRef} className="popout-term-host">
        <TerminalCore
          termId={params.termId}
          cwd={params.cwd}
          container={host}
          visible
          shellPath={params.shellPath}
          shellArgs={params.shellArgs}
          title={params.title}
          ptyId={params.ptyId}
          onPtyIdChange={(id) => {
            livePtyRef.current = id;
          }}
        />
      </div>
    </div>
  );
}
