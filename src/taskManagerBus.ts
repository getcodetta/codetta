// Same pattern as settingsBus: the Task Manager modal lives in App.tsx
// but is opened from the command registry / View menu.
type Listener = () => void;
const openListeners = new Set<Listener>();

export function openTaskManager() {
  for (const l of openListeners) l();
}

export function onTaskManagerOpen(cb: Listener): () => void {
  openListeners.add(cb);
  return () => openListeners.delete(cb);
}
