// Shared "push this linked local file to its remote path" used by the
// Remote panel's Push button, push-all-dirty, the file tree's
// right-click push, and the store's auto-push-on-save. Previously five
// near-identical implementations, none of which checked whether the
// remote file had changed underneath the user — a second writer
// (client via cPanel, wp-admin rewriting files, a teammate) was
// silently clobbered with a success toast.
//
// Responsibilities:
//   1. Stale check — stat the remote first; if its mtime is newer than
//      what we last saw, interactive pushes get an Overwrite/Cancel
//      dialog and auto-pushes skip with a warning (never silently
//      destroy remote work on Ctrl+S).
//   2. Byte-level upload (binary-safe).
//   3. Refresh the remote link with the post-push mtime so the next
//      comparison is exact (server clock vs ours doesn't matter).
//   4. Record the outcome in the deploy log.
//
// The caller is responsible for flushing dirty buffers BEFORE calling
// (store.saveFile) — this module deliberately doesn't import the store
// to stay cycle-free (the store itself calls in here for auto-push).

import { invoke } from "@tauri-apps/api/core";
import { confirm as dialogConfirm } from "./dialog";
import {
  error as toastError,
  errMsg,
  warning as toastWarning,
} from "./notify";
import {
  rememberRemoteLink,
  type RemoteLink,
} from "./sftpLinks";
import type { SftpConnectArgs } from "./sftpProfiles";
import { appendDeployLog } from "./deployLog";

interface SftpStat {
  size: number;
  mtime: number;
}

/** Clock-skew tolerance when comparing the remote mtime against our
 *  last-known value, in seconds. */
const MTIME_SKEW_S = 5;

export interface PushLinkedFileOpts {
  wsId: string;
  conn: SftpConnectArgs;
  localPath: string;
  link: RemoteLink;
  /** "interactive": remote-changed shows an Overwrite/Cancel dialog.
   *  "auto": remote-changed skips the push with a warning toast —
   *  auto-push on save must never clobber unseen remote edits. */
  mode: "interactive" | "auto";
}

/** Push one linked file. Returns true if the bytes were sent. */
export async function pushLinkedFile(
  opts: PushLinkedFileOpts,
): Promise<boolean> {
  const { wsId, conn, localPath, link, mode } = opts;
  const fileName = localPath.split(/[\\/]/).pop() ?? localPath;

  // 1. Stale check. Stat failures (file doesn't exist yet, transient
  // error) don't block the push — the upload itself will surface real
  // connection problems.
  let remoteStat: SftpStat | null = null;
  try {
    remoteStat = await invoke<SftpStat>("sftp_stat", {
      args: { ...conn, path: link.remotePath },
    });
  } catch {
    remoteStat = null;
  }
  // Prefer the exact post-push mtime when we have it (link.remoteMtime,
  // seconds); fall back to the wall-clock download time (millis).
  const knownMtimeS =
    link.remoteMtime ?? Math.floor(link.downloadedAt / 1000);
  if (remoteStat && remoteStat.mtime > knownMtimeS + MTIME_SKEW_S) {
    const when = new Date(remoteStat.mtime * 1000).toLocaleString();
    if (mode === "auto") {
      toastWarning(
        `Auto-push skipped for ${fileName}: the remote file changed at ${when}. Push manually to overwrite.`,
      );
      appendDeployLog(wsId, {
        op: "push",
        profileId: link.profileId,
        remotePath: link.remotePath,
        localPath,
        status: "skipped",
        detail: `remote changed at ${when}`,
      });
      return false;
    }
    const ok = await dialogConfirm(
      `The remote file changed at ${when} — after you last synced it.\n\n${link.remotePath}\n\nOverwrite the remote version?`,
      {
        title: "Remote file changed",
        okLabel: "Overwrite",
        cancelLabel: "Cancel",
        danger: true,
      },
    );
    if (!ok) {
      appendDeployLog(wsId, {
        op: "push",
        profileId: link.profileId,
        remotePath: link.remotePath,
        localPath,
        status: "skipped",
        detail: "user cancelled overwrite of changed remote",
      });
      return false;
    }
  }

  // 2. Upload (byte-level, binary-safe).
  try {
    const bytes = await invoke<number>("sftp_upload_from_disk", {
      args: { ...conn, remotePath: link.remotePath, localPath },
    });
    // 3. Refresh the link with the authoritative post-push mtime so
    // the next stale check compares server-clock to server-clock.
    let newMtime: number | undefined;
    try {
      const after = await invoke<SftpStat>("sftp_stat", {
        args: { ...conn, path: link.remotePath },
      });
      newMtime = after.mtime;
    } catch {
      newMtime = undefined;
    }
    rememberRemoteLink(wsId, localPath, {
      ...link,
      downloadedAt: Date.now(),
      remoteMtime: newMtime,
    });
    appendDeployLog(wsId, {
      op: "push",
      profileId: link.profileId,
      remotePath: link.remotePath,
      localPath,
      bytes,
      status: "ok",
    });
    return true;
  } catch (e) {
    appendDeployLog(wsId, {
      op: "push",
      profileId: link.profileId,
      remotePath: link.remotePath,
      localPath,
      status: "fail",
      detail: errMsg(e),
    });
    if (mode === "interactive") {
      toastError(`Push failed: ${errMsg(e)}`);
    } else {
      toastError(`Auto-push failed for ${fileName}: ${errMsg(e)}`);
    }
    return false;
  }
}
