type Listener = (section?: string) => void;
const openListeners = new Set<Listener>();

/** Open the Settings modal. Pass a section slug (e.g. "ai-providers")
 *  to deep-link straight to that section — several in-app links say
 *  "Settings → AI Providers" and should land there, not on Appearance.
 *  Slugs are the Section component's id (or auto-derived from its
 *  title: lowercase, non-alphanumerics → "-"). */
export function openSettings(section?: string) {
  for (const l of openListeners) l(section);
}

export function onSettingsOpen(cb: Listener): () => void {
  openListeners.add(cb);
  return () => openListeners.delete(cb);
}
