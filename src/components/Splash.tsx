import { useStore } from "../store";

// Injected by vite from package.json — see vite.config.ts `define`.
declare const __APP_VERSION__: string;
const VERSION = `v${__APP_VERSION__}`;

export function Splash() {
  const progress = useStore((s) => s.hydrateProgress);
  const pct = Math.max(
    0,
    Math.min(100, (progress.current / Math.max(1, progress.total)) * 100),
  );
  return (
    <div className="splash">
      <div className="splash-card">
        <div className="splash-mark">
          <span className="splash-mark-letter">C</span>
        </div>
        <div className="splash-wordmark">
          <span className="splash-wordmark-text">CODETTA</span>
          <span className="splash-wordmark-version">{VERSION}</span>
        </div>
        <div className="splash-tagline">
          A lightweight desktop code editor with first-class AI
        </div>
        <div className="splash-progress-track">
          <div
            className="splash-progress-fill"
            style={{ width: `${pct}%` }}
          />
          <div className="splash-progress-shimmer" />
        </div>
        <div className="splash-status">
          <span className="splash-phase">{progress.phase || "Loading…"}</span>
          <span className="splash-pct">{Math.round(pct)}%</span>
        </div>
      </div>
      <div className="splash-credit">
        © {new Date().getFullYear()} Codetta · Open source
      </div>
    </div>
  );
}
