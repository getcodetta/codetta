import { useStore } from "../store";

export function Splash() {
  const progress = useStore((s) => s.hydrateProgress);
  const pct = Math.max(
    0,
    Math.min(100, (progress.current / Math.max(1, progress.total)) * 100),
  );
  return (
    <div className="splash">
      <div className="splash-card">
        <div className="splash-brand">Codetta</div>
        <div className="splash-tagline">A lightweight desktop code editor with AI</div>
        <div className="splash-progress-track">
          <div
            className="splash-progress-fill"
            style={{ width: `${pct}%` }}
          />
        </div>
        <div className="splash-status">
          <span className="splash-phase">{progress.phase}</span>
          <span className="splash-pct">{Math.round(pct)}%</span>
        </div>
      </div>
    </div>
  );
}
