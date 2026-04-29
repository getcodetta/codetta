// Per-workspace move-to-front stack of recently-activated file paths.
// Used by the Ctrl+Tab "switch between recent files" overlay.

const MAX = 30;
const stacks = new Map<string, string[]>();

export function pushRecentFile(wsId: string, path: string) {
  const arr = stacks.get(wsId) ?? [];
  const filtered = arr.filter((p) => p !== path);
  filtered.unshift(path);
  stacks.set(wsId, filtered.slice(0, MAX));
}

export function dropRecentFile(wsId: string, path: string) {
  const arr = stacks.get(wsId);
  if (!arr) return;
  stacks.set(
    wsId,
    arr.filter((p) => p !== path),
  );
}

export function getRecentFiles(wsId: string): string[] {
  return stacks.get(wsId) ?? [];
}

export function clearRecentFiles(wsId: string) {
  stacks.delete(wsId);
}
