// Per-workspace deploy log — the visible record of every SFTP push /
// upload / download, success or failure. Bulk operations used to dump
// their failure lists to console.warn, which desktop users never see;
// this module is the recovery path ("which 3 files failed, and why?")
// and the foundation of the v0.5 "deploy editor" story.
//
// Storage mirrors the sftpLinks pattern: localStorage ring buffer per
// workspace (cap 200, newest first), module-level subscribe so the
// Remote panel updates live.

import { getJson, setJson } from "./localStore";

export interface DeployLogEntry {
  id: string;
  /** Wall-clock millis. */
  ts: number;
  op: "push" | "upload" | "download" | "sync-up" | "sync-down";
  profileId: string;
  remotePath: string;
  localPath?: string;
  bytes?: number;
  status: "ok" | "fail" | "skipped";
  /** Error text for fail; reason for skipped (e.g. remote-changed). */
  detail?: string;
}

const KEY = (wsId: string) => `lcp.deployLog.${wsId}`;
const CAP = 200;

const cache = new Map<string, DeployLogEntry[]>();

type Listener = (wsId: string) => void;
const listeners = new Set<Listener>();

export function subscribeDeployLog(fn: Listener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

function notifyAll(wsId: string) {
  for (const fn of listeners) fn(wsId);
}

export function loadDeployLog(wsId: string): DeployLogEntry[] {
  const hit = cache.get(wsId);
  if (hit) return hit;
  const parsed = getJson<DeployLogEntry[]>(KEY(wsId), [], Array.isArray);
  cache.set(wsId, parsed);
  return parsed;
}

export function appendDeployLog(
  wsId: string,
  entry: Omit<DeployLogEntry, "id" | "ts">,
): DeployLogEntry {
  const full: DeployLogEntry = {
    ...entry,
    id: "d_" + Math.random().toString(36).slice(2, 10),
    ts: Date.now(),
  };
  const next = [full, ...loadDeployLog(wsId)].slice(0, CAP);
  cache.set(wsId, next);
  setJson(KEY(wsId), next);
  notifyAll(wsId);
  return full;
}

export function clearDeployLog(wsId: string) {
  cache.set(wsId, []);
  setJson(KEY(wsId), []);
  notifyAll(wsId);
}
