// Tiny pub/sub for the notification-history modal. Mirrors shortcutsBus —
// the modal lives in App.tsx but the palette command that triggers it
// needs a way to reach across the component tree.

type Listener = () => void;
const listeners = new Set<Listener>();

export function openNotifications(): void {
  for (const l of listeners) l();
}

export function onNotificationsOpen(cb: Listener): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
