// Tracks "this local path was downloaded from this remote path on this
// SFTP profile". Stored per-workspace in localStorage so the link
// survives reloads. The editor toolbar / remote panel uses this to
// show a "Push to remote" action only for files that have a known
// upstream — preventing accidental uploads of unrelated local files.

import { getJson, setJson } from "./localStore";

const KEY = (wsId: string) => `lcp.sftp.links.${wsId}`;

export interface RemoteLink {
  profileId: string;
  remotePath: string;
  /** Wall-clock millis when the file was downloaded. Used for stale
   *  warnings if the remote file's mtime later differs. */
  downloadedAt: number;
  /** When true, store.saveFile pushes this file to the remote on every
   *  save (via the active SFTP session — silently no-ops when no
   *  session is connected, so saves don't block on the network). */
  autoPush?: boolean;
}

/** Normalize a local path so lookups match regardless of slash style
 *  or Windows drive-letter casing. Always lowercase drive + forward
 *  slashes. */
export function normalizeLocalPath(p: string): string {
  let n = p.replace(/\\/g, "/");
  // Lowercase Windows drive letter so "C:/foo" and "c:/foo" match.
  if (/^[a-zA-Z]:/.test(n)) {
    n = n.charAt(0).toLowerCase() + n.slice(1);
  }
  return n;
}

function load(wsId: string): Record<string, RemoteLink> {
  return getJson<Record<string, RemoteLink>>(
    KEY(wsId),
    {},
    (p): p is Record<string, RemoteLink> =>
      !!p && typeof p === "object" && !Array.isArray(p),
  );
}

function save(wsId: string, links: Record<string, RemoteLink>) {
  setJson(KEY(wsId), links);
}

export function rememberRemoteLink(
  wsId: string,
  localPath: string,
  link: RemoteLink,
) {
  const links = load(wsId);
  links[normalizeLocalPath(localPath)] = link;
  save(wsId, links);
}

export function lookupRemoteLink(
  wsId: string,
  localPath: string,
): RemoteLink | null {
  const links = load(wsId);
  return links[normalizeLocalPath(localPath)] ?? null;
}

type Listener = () => void;

// Active SFTP session registry — the connected RemoteSftpPanel
// publishes its current connection so other parts of the UI (the local
// file tree's right-click menu) can offer "upload to remote" against
// the live session without duplicating connection state.

export interface ActiveSftp {
  profileId: string;
  /** Connection params, snapshotted so the file tree can call
   *  sftp_write_file without re-reading localStorage. */
  conn: { host: string; port: number; user: string; password: string };
  /** Where the panel is currently rooted (defaultPath or home). Used as
   *  the suggested upload target. */
  cwd: string;
}

const activeSessions = new Map<string, ActiveSftp>();
const activeListeners = new Map<string, Set<Listener>>();

export function setActiveSftp(wsId: string, info: ActiveSftp | null) {
  if (info) activeSessions.set(wsId, info);
  else activeSessions.delete(wsId);
  const set = activeListeners.get(wsId);
  if (set) for (const l of set) l();
}

export function getActiveSftp(wsId: string): ActiveSftp | null {
  return activeSessions.get(wsId) ?? null;
}

export function subscribeActiveSftp(wsId: string, fn: Listener): () => void {
  let set = activeListeners.get(wsId);
  if (!set) {
    set = new Set();
    activeListeners.set(wsId, set);
  }
  set.add(fn);
  return () => {
    set!.delete(fn);
  };
}
