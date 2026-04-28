import { useEffect } from "react";
import { useStore } from "./store";
import { WorkspacePicker } from "./components/WorkspacePicker";
import { WorkspaceShell } from "./components/WorkspaceShell";
import { TitleBar } from "./components/TitleBar";
import "./App.css";

function App() {
  const hydrate = useStore((s) => s.hydrate);
  const hydrated = useStore((s) => s.hydrated);
  const activeId = useStore((s) => s.activeId);

  useEffect(() => {
    void hydrate();
  }, [hydrate]);

  if (!hydrated) {
    return <div className="boot">Loading…</div>;
  }

  return (
    <div className="app">
      <TitleBar />
      {activeId ? <WorkspaceShell /> : <WorkspacePicker />}
    </div>
  );
}

export default App;
