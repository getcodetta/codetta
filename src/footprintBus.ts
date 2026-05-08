type Listener = () => void;
const openListeners = new Set<Listener>();

export function openFootprint() {
  for (const l of openListeners) l();
}

export function onFootprintOpen(cb: Listener): () => void {
  openListeners.add(cb);
  return () => openListeners.delete(cb);
}
