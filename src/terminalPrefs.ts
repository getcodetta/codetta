// Default-shell preference for new terminals. Every spawn path
// (Ctrl+`, the + Term button, the auto-created first terminal) used to
// fall through to the backend's hardcoded system default — Windows
// PowerShell 5.1 on Windows — with no way to say "I live in pwsh /
// Git Bash". The picker dropdown still offers one-off choices; this is
// the persistent "what I get by default".
//
// The shell list is cached at module init: addTerminal is synchronous
// store code, so resolution must not await IPC. A miss (cache not yet
// filled, or the configured shell uninstalled) falls back to the
// system default — never a broken spawn.

import { getString, remove, setString } from "./localStore";
import { pty, type ShellOption } from "./ipc";

const KEY = "lcp.terminal.defaultShellId";

let cachedShells: ShellOption[] = [];
if (typeof window !== "undefined") {
  void pty
    .availableShells()
    .then((s) => {
      cachedShells = s;
    })
    .catch(() => {});
}

export function getDefaultShellId(): string {
  return getString(KEY) ?? "";
}

export function setDefaultShellId(id: string) {
  if (id) setString(KEY, id);
  else remove(KEY);
}

/** Resolve the preference to spawn params, or undefined = system
 *  default. */
export function resolveDefaultShell():
  | { path: string; args: string[]; label: string }
  | undefined {
  const id = getDefaultShellId();
  if (!id) return undefined;
  const sh = cachedShells.find((s) => s.id === id);
  return sh ? { path: sh.path, args: sh.args, label: sh.label } : undefined;
}
