// Tiny pub/sub for the keyboard-shortcut reference modal. Mirrors
// settingsBus — the modal lives in App.tsx but the action that
// triggers it (and the F1 keybinding) needs a way to reach across
// the component tree.

type Listener = () => void;
const openListeners = new Set<Listener>();

export function openShortcuts(): void {
  for (const l of openListeners) l();
}

export function onShortcutsOpen(cb: Listener): () => void {
  openListeners.add(cb);
  return () => openListeners.delete(cb);
}
