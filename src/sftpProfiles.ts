// Single source of truth for SFTP/SSH connection profiles.
//
// The profile schema + load/save/validation used to be duplicated in
// three places (RemoteSftpPanel, sftpProfilesEditor, plus ad-hoc conn
// snapshots) and had started to drift — the Settings editor dropped
// defaultPath/privateKeyPath on round-trip for a while. Everything that
// reads or writes `lcp.sftp.profiles` goes through here now.
//
// Passwords are stored locally in localStorage alongside the existing
// API-key trust model. Same caveat applies (anyone with disk access can
// read them).

import { getJson, setJson } from "./localStore";

export const SFTP_PROFILES_KEY = "lcp.sftp.profiles";

/** Same-window change signal. The DOM `storage` event only fires in
 *  OTHER windows, so the Remote panel never saw profiles added in the
 *  Settings modal sitting above it. Saving through saveSftpProfiles()
 *  dispatches this; onSftpProfilesChanged() listens for both. */
export const SFTP_PROFILES_CHANGED = "lcp:sftp-profiles-changed";

export interface SftpProfile {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  password: string;
  /** Optional remote folder to open on connect, e.g. "/var/www/site".
   *  When empty, falls back to the SSH home dir. */
  defaultPath?: string;
  /** Optional absolute path to an OpenSSH private key (PEM). When set,
   *  the backend tries key auth first; if the key is encrypted, the
   *  password field doubles as the passphrase. Falls back to password
   *  auth if the server rejects the key. */
  privateKeyPath?: string;
}

/** Connection args accepted by the sftp_* Tauri commands. */
export interface SftpConnectArgs {
  host: string;
  port: number;
  user: string;
  password: string;
  privateKeyPath?: string;
}

export function loadSftpProfiles(): SftpProfile[] {
  return getJson<unknown[]>(SFTP_PROFILES_KEY, [], Array.isArray)
    .filter(
      (p): p is SftpProfile =>
        !!p &&
        typeof p === "object" &&
        typeof (p as SftpProfile).id === "string" &&
        typeof (p as SftpProfile).name === "string" &&
        typeof (p as SftpProfile).host === "string" &&
        typeof (p as SftpProfile).user === "string" &&
        typeof (p as SftpProfile).password === "string" &&
        typeof (p as SftpProfile).port === "number",
    )
    .map((p) => ({
      ...p,
      defaultPath:
        typeof p.defaultPath === "string" ? p.defaultPath : undefined,
      privateKeyPath:
        typeof p.privateKeyPath === "string" ? p.privateKeyPath : undefined,
    }));
}

export function saveSftpProfiles(profiles: SftpProfile[]) {
  setJson(SFTP_PROFILES_KEY, profiles);
  window.dispatchEvent(new CustomEvent(SFTP_PROFILES_CHANGED));
}

/** Subscribe to profile changes from this window (custom event) and
 *  other windows (storage event). Returns an unsubscribe. */
export function onSftpProfilesChanged(fn: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === SFTP_PROFILES_KEY) fn();
  };
  window.addEventListener(SFTP_PROFILES_CHANGED, fn);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(SFTP_PROFILES_CHANGED, fn);
    window.removeEventListener("storage", onStorage);
  };
}

export function emptySftpProfile(): SftpProfile {
  return {
    id: "p_" + Math.random().toString(36).slice(2, 10),
    name: "",
    host: "",
    port: 22,
    user: "",
    password: "",
    defaultPath: "",
    privateKeyPath: "",
  };
}

export function profileToConn(p: SftpProfile): SftpConnectArgs {
  return {
    host: p.host,
    port: p.port,
    user: p.user,
    password: p.password,
    privateKeyPath: p.privateKeyPath?.trim() || undefined,
  };
}

export function findSftpProfile(id: string): SftpProfile | null {
  return loadSftpProfiles().find((p) => p.id === id) ?? null;
}
