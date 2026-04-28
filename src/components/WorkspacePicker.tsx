import { open } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store";

export function WorkspacePicker() {
  const recent = useStore((s) => s.recent);
  const openWs = useStore((s) => s.openWorkspace);
  const removeWs = useStore((s) => s.removeWorkspace);

  async function pickFolder() {
    const sel = await open({ directory: true, multiple: false });
    if (typeof sel === "string") {
      await openWs(sel);
    }
  }

  return (
    <div className="picker">
      <div className="picker-card">
        <h1>Lite Coder Pro</h1>
        <p className="muted">Open a project folder to start.</p>
        <button className="primary" onClick={pickFolder}>
          Open Folder…
        </button>

        {recent.length > 0 && (
          <>
            <h2>Recent</h2>
            <ul className="recent-list">
              {recent.map((w) => (
                <li key={w.id}>
                  <button
                    className="recent-row"
                    onClick={() => openWs(w.root)}
                    title={w.root}
                  >
                    <span className="recent-name">{w.name}</span>
                    <span className="recent-path">{w.root}</span>
                  </button>
                  <button
                    className="recent-remove"
                    title="Remove from list"
                    onClick={(e) => {
                      e.stopPropagation();
                      removeWs(w.id);
                    }}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
