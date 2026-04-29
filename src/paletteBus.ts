type Listener = (initialQuery: string) => void;
const openListeners = new Set<Listener>();

export function openPalette(initialQuery = "") {
  for (const l of openListeners) l(initialQuery);
}

export function onPaletteOpen(cb: Listener): () => void {
  openListeners.add(cb);
  return () => openListeners.delete(cb);
}
