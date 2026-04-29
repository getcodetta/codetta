type Listener = () => void;
const openListeners = new Set<Listener>();

export function openSettings() {
  for (const l of openListeners) l();
}

export function onSettingsOpen(cb: Listener): () => void {
  openListeners.add(cb);
  return () => openListeners.delete(cb);
}
