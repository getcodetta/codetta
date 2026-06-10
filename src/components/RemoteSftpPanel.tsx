import { useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { useStore } from "../store";
import { useEditorState } from "../editorState";
import { fs } from "../ipc";
import {
  error as toastError,
  errMsg,
  info as toastInfo,
  success as toastSuccess,
} from "../notify";
import { ContextMenu, type ContextMenuItem } from "./ContextMenu";
import { confirm as dialogConfirm, prompt as dialogPrompt } from "../dialog";
import {
  getString as lsGetString,
  setString as lsSetString,
} from "../localStore";
import {
  rememberRemoteLink,
  lookupRemoteLink,
  setActiveSftp,
} from "../sftpLinks";
import { pushLinkedFile } from "../sftpPush";
import {
  emptySftpProfile as emptyProfile,
  findSftpProfile,
  loadSftpProfiles as loadProfiles,
  onSftpProfilesChanged,
  profileToConn,
  saveSftpProfiles as saveProfiles,
  type SftpProfile,
} from "../sftpProfiles";
import {
  appendDeployLog,
  clearDeployLog,
  loadDeployLog,
  subscribeDeployLog,
  type DeployLogEntry,
} from "../deployLog";
import { basename, dirname } from "../pathUtils";
import { Icon } from "./Icon";

const SFTP_LAST_PROFILE_KEY = (wsId: string) =>
  `lcp.sftp.lastProfile.${wsId}`;

interface SftpEntry {
  name: string;
  kind: string;
  size: number;
  mtime: number;
}

function joinRemote(parent: string, name: string): string {
  if (parent === "/" || parent === "") return "/" + name;
  return parent.replace(/\/$/, "") + "/" + name;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

interface DirNode {
  // null while loading, [] when loaded-and-empty, populated otherwise.
  entries: SftpEntry[] | null;
  expanded: Set<string>; // child names that are expanded
  children: Map<string, DirNode>; // child name → its DirNode (lazily created)
}

function emptyDirNode(): DirNode {
  return { entries: null, expanded: new Set(), children: new Map() };
}

interface Props {
  wsId: string;
  root: string;
}

export function RemoteSftpPanel({ wsId, root }: Props) {
  const [profiles, setProfiles] = useState<SftpProfile[]>(() => loadProfiles());
  const [profileId, setProfileId] = useState<string>(
    () => lsGetString(SFTP_LAST_PROFILE_KEY(wsId)) ?? "",
  );
  // Inline editor for adding/editing a profile without opening Settings.
  // Null = closed; populated = render the form. Same shape as Settings,
  // shorter since we only need create + connect-immediately flow.
  const [editing, setEditing] = useState<SftpProfile | null>(null);
  const [testMsg, setTestMsg] = useState<{
    kind: "idle" | "testing" | "ok" | "fail";
    text?: string;
  }>({ kind: "idle" });
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "connecting" }
    | { kind: "connected"; home: string }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  // Currently-viewed root in the remote tree. null → use the home dir
  // we discovered on connect. Set to a different absolute path when the
  // user clicks a breadcrumb segment to drill up. Reset on disconnect /
  // connect so a new session starts at home.
  const [viewPath, setViewPath] = useState<string | null>(null);
  // Tree data keyed by absolute remote path. The root node is at the
  // home dir we discovered on connect. Values mutate in place via the
  // setTree(prev => ...) updater pattern so React still sees a new
  // reference to trigger re-renders.
  const [tree, setTree] = useState<Map<string, DirNode>>(new Map());
  // Force-rerender token. Mutating tree contents in place doesn't
  // change the Map reference, so we bump this to trigger re-renders.
  const [version, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  const profile = useMemo(
    () => profiles.find((p) => p.id === profileId) ?? null,
    [profiles, profileId],
  );

  // Right-click context menu state. Single shared menu — closed when
  // null. We store the items inline so each call site can set up its
  // own action list.
  const [ctxMenu, setCtxMenu] = useState<{
    x: number;
    y: number;
    items: (ContextMenuItem | "separator")[];
  } | null>(null);

  // Currently-active editor file path — used by the "Push current file"
  // action. Updates whenever the editor moves.
  const editorState = useEditorState();
  const activeFilePath = editorState.filePath;

  // Re-read profiles when they change anywhere — the Settings modal in
  // this window (custom event; the DOM storage event never fires in the
  // window that wrote it) or another Codetta window (storage event).
  useEffect(() => {
    return onSftpProfilesChanged(() => setProfiles(loadProfiles()));
  }, []);

  // Persist last-picked profile per workspace so reopening the panel
  // reconnects to the right server.
  useEffect(() => {
    if (profileId) lsSetString(SFTP_LAST_PROFILE_KEY(wsId), profileId);
  }, [profileId, wsId]);

  const connect = async () => {
    if (!profile) return;
    await connectProfile(profile);
  };

  const disconnect = () => {
    if (profile) {
      // Best-effort evict from the Rust pool so the SSH channel
      // closes promptly. We don't await — disconnect should feel
      // instant from the user's POV.
      void invoke("sftp_disconnect", { args: profileToConn(profile) }).catch(
        () => {},
      );
    }
    setTree(new Map());
    setStatus({ kind: "idle" });
    setActiveSftp(wsId, null);
  };

  // Make sure we publish "no active session" if this panel unmounts
  // (e.g. user removes the sidebar section while connected).
  useEffect(() => {
    return () => setActiveSftp(wsId, null);
  }, [wsId]);

  const startNewProfile = () => {
    setEditing(emptyProfile());
    setTestMsg({ kind: "idle" });
  };

  const cancelEditing = () => {
    setEditing(null);
    setTestMsg({ kind: "idle" });
  };

  const testEditing = async () => {
    if (!editing || !editing.host || !editing.user) return;
    setTestMsg({ kind: "testing" });
    try {
      const result = await invoke<{
        server_banner: string;
        home_dir: string;
      }>("sftp_test_connection", {
        args: profileToConn(editing),
      });
      setTestMsg({
        kind: "ok",
        text: `${result.server_banner} — ${result.home_dir}`,
      });
    } catch (e) {
      setTestMsg({
        kind: "fail",
        text: errMsg(e),
      });
    }
  };

  const saveEditing = (alsoConnect: boolean) => {
    if (!editing || !editing.host || !editing.user) return;
    const cleaned: SftpProfile = {
      ...editing,
      name: editing.name.trim() || `${editing.user}@${editing.host}`,
      host: editing.host.trim(),
      user: editing.user.trim(),
      port: Math.max(1, Math.min(65535, editing.port || 22)),
    };
    const next = [...profiles.filter((p) => p.id !== cleaned.id), cleaned];
    setProfiles(next);
    saveProfiles(next);
    setProfileId(cleaned.id);
    setEditing(null);
    setTestMsg({ kind: "idle" });
    if (alsoConnect) {
      // Use the freshly-saved profile directly rather than waiting for
      // the profileId state update to flow through the memo.
      void connectProfile(cleaned);
    }
  };

  const connectProfile = async (p: SftpProfile) => {
    setStatus({ kind: "connecting" });
    try {
      const result = await invoke<{
        server_banner: string;
        home_dir: string;
        entry_count: number;
      }>("sftp_test_connection", { args: profileToConn(p) });
      // Prefer the user-configured defaultPath (e.g. /var/www/site)
      // over the SSH home dir, so users land where they actually work.
      const trimmedDefault = (p.defaultPath ?? "").trim();
      const home = trimmedDefault || result.home_dir || "/";
      const next = new Map<string, DirNode>();
      next.set(home, emptyDirNode());
      setTree(next);
      setStatus({ kind: "connected", home });
      // Publish so the local file-tree right-click can offer
      // "Upload to remote" against this live session.
      setActiveSftp(wsId, {
        profileId: p.id,
        conn: profileToConn(p),
        cwd: home,
      });
      // Reset viewPath so a fresh connect always lands at home rather
      // than wherever the previous session was browsing.
      setViewPath(null);
      void loadDir(home, p, next);
    } catch (e) {
      setStatus({
        kind: "error",
        message: errMsg(e),
      });
    }
  };

  const startEditProfile = (p: SftpProfile) => {
    setEditing({ ...p });
    setTestMsg({ kind: "idle" });
  };

  const loadDir = async (
    path: string,
    p: SftpProfile,
    treeRef: Map<string, DirNode>,
  ) => {
    try {
      const entries = await invoke<SftpEntry[]>("sftp_list_dir", {
        args: { ...profileToConn(p), path },
      });
      const node = treeRef.get(path) ?? emptyDirNode();
      node.entries = entries;
      treeRef.set(path, node);
      bump();
    } catch (e) {
      toastError(`Failed to list ${path}: ${errMsg(e)}`);
      const node = treeRef.get(path) ?? emptyDirNode();
      node.entries = [];
      treeRef.set(path, node);
      bump();
    }
  };

  const toggleDir = async (parentPath: string, name: string) => {
    if (!profile) return;
    const parentNode = tree.get(parentPath);
    if (!parentNode) return;
    const childPath = joinRemote(parentPath, name);
    if (parentNode.expanded.has(name)) {
      parentNode.expanded.delete(name);
      bump();
      return;
    }
    parentNode.expanded.add(name);
    if (!tree.has(childPath)) {
      tree.set(childPath, emptyDirNode());
    }
    bump();
    const childNode = tree.get(childPath)!;
    if (childNode.entries === null) {
      await loadDir(childPath, profile, tree);
    }
  };

  const refreshDir = async (path: string) => {
    if (!profile) return;
    await loadDir(path, profile, tree);
    toastInfo(`Refreshed ${path}`);
  };

  const downloadFile = async (remotePath: string, suggestedName: string) => {
    if (!profile) return;
    try {
      const localPath = await saveDialog({
        defaultPath: `${root.replace(/\\/g, "/")}/${suggestedName}`,
        title: `Save ${suggestedName} as…`,
      });
      if (!localPath) return;
      // Byte-level transfer — the old string round-trip via
      // sftp_read_file failed on any non-UTF-8 file (images, zips).
      const bytes = await invoke<number>("sftp_download_to_disk", {
        args: {
          ...profileToConn(profile),
          remotePath,
          localPath,
        },
      });
      appendDeployLog(wsId, {
        op: "download",
        profileId: profile.id,
        remotePath,
        localPath,
        bytes,
        status: "ok",
      });
      // Remember the round-trip so Push-to-remote works on this file.
      rememberRemoteLink(wsId, localPath, {
        profileId: profile.id,
        remotePath,
        downloadedAt: Date.now(),
      });
      toastSuccess(`Downloaded ${suggestedName}`);
    } catch (e) {
      toastError(
        `Download failed: ${errMsg(e)}`,
      );
    }
  };

  const openInEditor = async (remotePath: string, name: string) => {
    if (!profile) return;
    try {
      const contents = await invoke<string>("sftp_read_file", {
        args: { ...profileToConn(profile), path: remotePath },
      });
      // Cache to a workspace-local hidden folder so the user can edit
      // it normally. The remote-link table remembers the upstream
      // remote path, so a subsequent "Push to remote" knows where to
      // send changes back without re-asking.
      //
      // The cache path mirrors profile id + the full remote path, NOT
      // the bare filename: CMS trees repeat names constantly
      // (index.php, style.css), and a flat cache would overwrite the
      // first file's buffer AND relink its push target to the second —
      // pushing the wrong content to the wrong production file.
      const cacheDir = `${root.replace(/\\/g, "/")}/.codetta-remote-cache`;
      const safeRemote = remotePath
        .replace(/[:*?"<>|]/g, "_")
        .replace(/^\/+/, "");
      const localPath = `${cacheDir}/${profile.id}/${safeRemote}`;
      await fs.createDir(dirname(localPath)).catch(() => {});
      await fs.writeFile(localPath, contents);
      rememberRemoteLink(wsId, localPath, {
        profileId: profile.id,
        remotePath,
        downloadedAt: Date.now(),
      });
      await useStore.getState().openFile(wsId, localPath);
      toastInfo(
        `Opened ${name} — edit and use the Push button in the panel header to send changes back.`,
      );
    } catch (e) {
      toastError(`Open failed: ${errMsg(e)}`);
    }
  };

  // Upload a local file (chosen via dialog) into a remote folder.
  const uploadHere = async (parentPath: string) => {
    if (!profile) return;
    try {
      const localPath = await openDialog({
        multiple: false,
        title: "Pick a file to upload",
      });
      if (!localPath || typeof localPath !== "string") return;
      await uploadLocalFile(parentPath, localPath);
    } catch (e) {
      toastError(
        `Upload failed: ${errMsg(e)}`,
      );
    }
  };

  const uploadLocalFile = async (parentPath: string, localPath: string) => {
    if (!profile) return;
    const fileName = basename(localPath);
    const remotePath = joinRemote(parentPath, fileName);
    // Byte-level transfer — fs.readFile rejects binary local files, so
    // the old string hop couldn't upload images/fonts.
    let bytes: number;
    try {
      bytes = await invoke<number>("sftp_upload_from_disk", {
        args: { ...profileToConn(profile), remotePath, localPath },
      });
    } catch (e) {
      appendDeployLog(wsId, {
        op: "upload",
        profileId: profile.id,
        remotePath,
        localPath,
        status: "fail",
        detail: errMsg(e),
      });
      throw e;
    }
    appendDeployLog(wsId, {
      op: "upload",
      profileId: profile.id,
      remotePath,
      localPath,
      bytes,
      status: "ok",
    });
    // Record the link so subsequent edits to this local file can push
    // back without re-asking for a target.
    rememberRemoteLink(wsId, localPath, {
      profileId: profile.id,
      remotePath,
      downloadedAt: Date.now(),
    });
    toastSuccess(`Uploaded ${fileName} → ${remotePath}`);
    await loadDir(parentPath, profile, tree);
  };

  // Push every open buffer in this workspace that (a) is linked to a
  // remote path on the currently-connected profile AND (b) is dirty
  // (contents !== original on disk). Saves first, then pushes.
  // Reports the count + any failures via toast.
  const pushAllDirty = async () => {
    if (!profile) return;
    const ws = useStore.getState().loaded[wsId];
    if (!ws) return;
    const candidates: { path: string; remotePath: string }[] = [];
    for (const [path, f] of Object.entries(ws.files)) {
      const link = lookupRemoteLink(wsId, path);
      if (!link || link.profileId !== profile.id) continue;
      if (f.contents === f.original) continue;
      candidates.push({ path, remotePath: link.remotePath });
    }
    if (candidates.length === 0) {
      toastInfo("No dirty linked files to push.");
      return;
    }
    toastInfo(`Pushing ${candidates.length} file${candidates.length === 1 ? "" : "s"}…`);
    let okCount = 0;
    for (const c of candidates) {
      // Save first so the on-disk contents match what we push.
      await useStore.getState().saveFile(wsId, c.path);
      const link = lookupRemoteLink(wsId, c.path);
      if (!link) continue;
      const sent = await pushLinkedFile({
        wsId,
        conn: profileToConn(profile),
        localPath: c.path,
        link,
        mode: "interactive",
      });
      if (sent) okCount++;
    }
    if (okCount === candidates.length) {
      toastSuccess(`Pushed ${okCount} file${okCount === 1 ? "" : "s"}`);
    } else {
      toastError(
        `Pushed ${okCount}/${candidates.length} — see the Deploy log below for details`,
      );
    }
  };

  // Push the active editor file to its tracked remote path. If the
  // file has no remote link, falls through to a "save as" prompt.
  const pushActiveFile = async () => {
    if (!profile) return;
    if (!activeFilePath) {
      toastError("No active editor file to push.");
      return;
    }
    const link = lookupRemoteLink(wsId, activeFilePath);
    if (link && link.profileId !== profile.id) {
      const ok = await dialogConfirm(
        `This file was downloaded from a different SFTP profile. Push anyway to ${profile.host}?`,
      );
      if (!ok) return;
    }
    if (!link) {
      toastError(
        "This file isn't linked to a remote path yet. Right-click a remote folder → Upload current editor file here.",
      );
      return;
    }
    // Save first so we push what the user sees in the editor, not
    // the last on-disk version (saveFile no-ops when clean).
    await useStore.getState().saveFile(wsId, activeFilePath);
    const sent = await pushLinkedFile({
      wsId,
      conn: profileToConn(profile),
      localPath: activeFilePath,
      link,
      mode: "interactive",
    });
    if (sent) toastSuccess(`Pushed → ${link.remotePath}`);
  };

  // Upload the active editor file into a chosen remote folder, even
  // if the file has no existing link. Used by the "Upload current
  // editor file here" right-click action on folders.
  const uploadActiveFileTo = async (parentPath: string) => {
    if (!profile) return;
    if (!activeFilePath) {
      toastError("No active editor file to upload.");
      return;
    }
    try {
      await uploadLocalFile(parentPath, activeFilePath);
    } catch (e) {
      toastError(
        `Upload failed: ${errMsg(e)}`,
      );
    }
  };

  const deleteRemote = async (remotePath: string, name: string, isDir: boolean) => {
    if (!profile) return;
    if (isDir) {
      // Folder deletes are gated with type-to-confirm — a stray click
      // shouldn't be able to wipe out a server directory. The user
      // must type the folder name exactly. (The backend additionally
      // refuses to recursively rm — only empty dirs delete; full
      // tree removal would be its own feature with extra guards.)
      const typed = await dialogPrompt(
        `DELETE FOLDER on remote?\n\n${remotePath}\n\nThis cannot be undone.\n\nType the folder name (${name}) to confirm:`,
        "",
        {
          title: "Confirm folder delete",
          okLabel: "Delete",
          cancelLabel: "Cancel",
        },
      );
      if (typed === null) return;
      if (typed.trim() !== name) {
        toastError(`Cancelled — typed "${typed}", expected "${name}"`);
        return;
      }
    } else {
      const ok = await dialogConfirm(
        `Delete file on remote?\n\n${remotePath}\n\nThis cannot be undone.`,
      );
      if (!ok) return;
    }
    try {
      await invoke("sftp_delete", {
        args: { ...profileToConn(profile), path: remotePath, is_dir: isDir },
      });
      toastSuccess(`Deleted ${name}`);
      // Refresh the parent dir.
      const parent = remotePath.replace(/\/[^/]+$/, "") || "/";
      await loadDir(parent, profile, tree);
    } catch (e) {
      toastError(`Delete failed: ${errMsg(e)}`);
    }
  };

  // ---------- Context-menu builders ----------

  const downloadFolderRecursive = async (folderPath: string, folderName: string) => {
    if (!profile) return;
    try {
      const localTarget = await openDialog({
        directory: true,
        multiple: false,
        title: `Pick a local folder to download "${folderName}" into`,
      });
      if (!localTarget || typeof localTarget !== "string") return;
      // Save into a subfolder named after the remote dir, so the user
      // doesn't accidentally splat 500 files into their workspace root.
      const finalLocal = `${localTarget.replace(/\\/g, "/")}/${folderName}`;
      toastInfo(`Downloading ${folderName} → ${finalLocal}…`);
      const result = await invoke<{
        files: number;
        bytes: number;
        failed: string[];
      }>("sftp_download_dir", {
        args: {
          ...profileToConn(profile),
          remote_path: folderPath,
          local_path: finalLocal,
        },
      });
      const mb = (result.bytes / 1024 / 1024).toFixed(2);
      if (result.failed.length === 0) {
        toastSuccess(
          `Downloaded ${result.files} files (${mb} MB) → ${finalLocal}`,
        );
      } else {
        toastError(
          `Downloaded ${result.files}/${result.files + result.failed.length} files (${mb} MB). ${result.failed.length} failed — check console.`,
        );
        console.warn("sftp_download_dir failures:", result.failed);
      }
    } catch (e) {
      toastError(
        `Recursive download failed: ${errMsg(e)}`,
      );
    }
  };

  const uploadFolderRecursive = async (folderPath: string) => {
    if (!profile) return;
    try {
      const localFolder = await openDialog({
        directory: true,
        multiple: false,
        title: "Pick a local folder to upload into this remote folder",
      });
      if (!localFolder || typeof localFolder !== "string") return;
      const localName =
        localFolder.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? "upload";
      const remoteTarget = joinRemote(folderPath, localName);
      const ok = await dialogConfirm(
        `Upload contents of:\n  ${localFolder}\n→ remote:\n  ${remoteTarget}\n\nThis will create files on the server. Heavy dirs (.git, node_modules, dist…) are skipped.`,
      );
      if (!ok) return;
      toastInfo(`Uploading ${localName} → ${remoteTarget}…`);
      const result = await invoke<{
        files: number;
        bytes: number;
        failed: string[];
      }>("sftp_upload_dir", {
        args: {
          ...profileToConn(profile),
          local_path: localFolder,
          remote_path: remoteTarget,
        },
      });
      const mb = (result.bytes / 1024 / 1024).toFixed(2);
      if (result.failed.length === 0) {
        toastSuccess(
          `Uploaded ${result.files} files (${mb} MB) → ${remoteTarget}`,
        );
      } else {
        toastError(
          `Uploaded ${result.files}/${result.files + result.failed.length} files (${mb} MB). ${result.failed.length} failed — check console.`,
        );
        console.warn("sftp_upload_dir failures:", result.failed);
      }
      await loadDir(folderPath, profile, tree);
    } catch (e) {
      toastError(
        `Recursive upload failed: ${errMsg(e)}`,
      );
    }
  };

  const openFolderMenu = (
    e: React.MouseEvent,
    folderPath: string,
    folderName: string,
  ) => {
    e.preventDefault();
    const items: (ContextMenuItem | "separator")[] = [
      {
        label: "Refresh",
        onClick: () => refreshDir(folderPath),
      },
      "separator",
      {
        label: "Upload local file here…",
        onClick: () => uploadHere(folderPath),
      },
      {
        label: activeFilePath
          ? `Upload current editor file here (${basename(activeFilePath)})`
          : "Upload current editor file here",
        disabled: !activeFilePath,
        onClick: () => uploadActiveFileTo(folderPath),
      },
      {
        label: "Upload local folder here (recursive)…",
        onClick: () => uploadFolderRecursive(folderPath),
      },
      "separator",
      {
        label: `Download "${folderName}" recursively…`,
        onClick: () => downloadFolderRecursive(folderPath, folderName),
      },
      "separator",
      {
        label: `Delete folder "${folderName}"`,
        danger: true,
        onClick: () => deleteRemote(folderPath, folderName, true),
      },
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  };

  const openFileMenu = (
    e: React.MouseEvent,
    filePath: string,
    fileName: string,
  ) => {
    e.preventDefault();
    const items: (ContextMenuItem | "separator")[] = [
      {
        label: "Open in editor",
        onClick: () => openInEditor(filePath, fileName),
      },
      {
        label: "Download to…",
        onClick: () => downloadFile(filePath, fileName),
      },
      "separator",
      {
        label: `Delete "${fileName}"`,
        danger: true,
        onClick: () => deleteRemote(filePath, fileName, false),
      },
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  };

  // Header right-click for "global" actions on the connection itself.
  const openHeaderMenu = (e: React.MouseEvent, home: string) => {
    e.preventDefault();
    const items: (ContextMenuItem | "separator")[] = [
      { label: "Refresh root", onClick: () => refreshDir(home) },
      {
        label: "Upload local file to home…",
        onClick: () => uploadHere(home),
      },
      {
        label: activeFilePath
          ? `Push current editor file (${basename(activeFilePath)})`
          : "Push current editor file",
        disabled:
          !activeFilePath ||
          !lookupRemoteLink(wsId, activeFilePath ?? ""),
        onClick: () => pushActiveFile(),
      },
      "separator",
      {
        label: "Edit this connection…",
        disabled: !profile,
        onClick: () => {
          if (profile) startEditProfile(profile);
        },
      },
      { label: "Disconnect", onClick: () => disconnect() },
    ];
    setCtxMenu({ x: e.clientX, y: e.clientY, items });
  };

  // ---------- Render ----------

  if (status.kind === "idle") {
    if (editing) {
      return (
        <div className="remote-panel">
          <RemoteProfileForm
            profile={editing}
            testMsg={testMsg}
            onChange={setEditing}
            onTest={() => void testEditing()}
            onSave={() => saveEditing(false)}
            onSaveAndConnect={() => saveEditing(true)}
            onCancel={cancelEditing}
            allowCancel={profiles.length > 0}
          />
        </div>
      );
    }
    return (
      <div className="remote-panel">
        <div className="remote-panel-empty">
          {profiles.length === 0 ? (
            <>
              <p>No SFTP connections saved yet.</p>
              <button
                className="remote-connect-btn"
                onClick={startNewProfile}
              >
                + Add connection
              </button>
              <p className="remote-panel-hint">
                You can also manage saved profiles in{" "}
                <strong>Settings → SFTP — Remote connections</strong>.
              </p>
            </>
          ) : (
            <>
              <label className="remote-label">Connection</label>
              <select
                className="remote-select"
                value={profileId}
                onChange={(e) => {
                  if (e.target.value === "__new__") {
                    startNewProfile();
                  } else {
                    setProfileId(e.target.value);
                  }
                }}
              >
                <option value="">— pick a connection —</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name} ({p.user}@{p.host})
                  </option>
                ))}
                <option value="__new__">+ Add new connection…</option>
              </select>
              <div className="remote-button-row">
                <button
                  className="remote-connect-btn"
                  disabled={!profile}
                  onClick={() => void connect()}
                >
                  Connect
                </button>
                <button
                  className="remote-disconnect-btn"
                  disabled={!profile}
                  onClick={() => profile && startEditProfile(profile)}
                  title="Edit the selected connection"
                >
                  Edit
                </button>
                <button
                  className="remote-disconnect-btn"
                  onClick={startNewProfile}
                  title="Add another connection inline"
                >
                  + New
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    );
  }

  if (status.kind === "connecting") {
    return (
      <div className="remote-panel">
        <div className="remote-panel-empty">
          <span className="ai-spinner" /> Connecting to {profile?.host}…
        </div>
      </div>
    );
  }

  if (status.kind === "error") {
    return (
      <div className="remote-panel">
        <div className="remote-panel-empty remote-panel-error">
          <strong>Connection failed</strong>
          <pre className="remote-error-text">{status.message}</pre>
          <button
            className="remote-connect-btn"
            onClick={() => void connect()}
          >
            Retry
          </button>
          <button
            className="remote-disconnect-btn"
            onClick={() => disconnect()}
          >
            Cancel
          </button>
        </div>
      </div>
    );
  }

  const home = status.home;
  // viewPath overrides home when the user has navigated to an ancestor
  // via the breadcrumb. Falls back to home when null.
  const viewRoot = viewPath ?? home;
  const navigateTo = (path: string) => {
    if (!profile) return;
    setViewPath(path === home ? null : path);
    if (!tree.has(path)) {
      tree.set(path, emptyDirNode());
      void loadDir(path, profile, tree);
    }
  };
  const activeLink = activeFilePath
    ? lookupRemoteLink(wsId, activeFilePath)
    : null;
  const activeIsLinked = activeLink !== null;
  const activeAutoPush = activeLink?.autoPush === true;
  const toggleActiveAutoPush = () => {
    if (!activeFilePath || !activeLink) return;
    rememberRemoteLink(wsId, activeFilePath, {
      ...activeLink,
      autoPush: !activeLink.autoPush,
    });
    // Force a re-render to pick up the new toggle state.
    bump();
    toastInfo(
      !activeLink.autoPush
        ? `Auto-push enabled for ${activeFilePath.split(/[\\/]/).pop()}`
        : `Auto-push disabled for ${activeFilePath.split(/[\\/]/).pop()}`,
    );
  };
  return (
    <div className="remote-panel" data-version={version}>
      <div
        className="remote-panel-header"
        onContextMenu={(e) => openHeaderMenu(e, home)}
      >
        <div className="remote-panel-host" title={`${profile?.user}@${profile?.host}:${profile?.port}`}>
          {profile?.name || `${profile?.user}@${profile?.host}`}
        </div>
        <div className="remote-panel-actions">
          <button
            className={`remote-icon-btn ${activeIsLinked ? "remote-icon-btn-accent" : ""}`}
            onClick={() => void pushActiveFile()}
            disabled={!activeIsLinked}
            title={
              activeIsLinked
                ? `Push current editor file to its tracked remote path`
                : "Push to remote (open a file from the remote tree first, or right-click a folder → Upload current editor file here)"
            }
            aria-label="Push current file"
          >
            <Icon name="upload-cloud" size={14} />
          </button>
          <button
            className={`remote-icon-btn ${activeAutoPush ? "remote-icon-btn-accent" : ""}`}
            onClick={toggleActiveAutoPush}
            disabled={!activeIsLinked}
            title={
              !activeIsLinked
                ? "Auto-push (link a file first)"
                : activeAutoPush
                  ? "Auto-push: ON for this file. Click to disable."
                  : "Auto-push: OFF. Click to push this file to remote on every save."
            }
            aria-pressed={activeAutoPush}
            aria-label="Auto-push on save"
          >
            <Icon name={activeAutoPush ? "star-filled" : "star"} size={14} />
          </button>
          <button
            className="remote-icon-btn"
            onClick={() => void pushAllDirty()}
            title="Push every dirty linked file in this workspace to its tracked remote path"
            aria-label="Push all dirty files"
          >
            <Icon name="upload-cloud" size={14} />
          </button>
          <button
            className="remote-icon-btn"
            onClick={() => void uploadHere(home)}
            title="Upload a local file to home"
            aria-label="Upload to home"
          >
            <Icon name="upload" size={14} />
          </button>
          <button
            className="remote-icon-btn"
            onClick={() => void refreshDir(home)}
            title="Refresh"
            aria-label="Refresh remote tree"
          >
            <Icon name="refresh" size={14} />
          </button>
          <button
            className="remote-icon-btn"
            onClick={() => disconnect()}
            title="Disconnect"
            aria-label="Disconnect"
          >
            <Icon name="eject" size={14} />
          </button>
        </div>
      </div>
      <div className="remote-panel-pwd" title={viewRoot}>
        <RemoteBreadcrumb
          path={viewRoot}
          home={home}
          onJump={navigateTo}
        />
      </div>
      <div className="remote-tree">
        <RemoteDirChildren
          path={viewRoot}
          tree={tree}
          depth={0}
          onToggle={toggleDir}
          onOpenFile={openInEditor}
          onFileMenu={openFileMenu}
          onFolderMenu={openFolderMenu}
        />
      </div>
      <DeployLogStrip wsId={wsId} profile={profile} />
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          items={ctxMenu.items}
          onClose={() => setCtxMenu(null)}
        />
      )}
    </div>
  );
}

interface DeployLogStripProps {
  wsId: string;
  profile: SftpProfile | null;
}

/** Collapsible record of recent pushes/uploads/downloads with
 *  per-entry retry. Bulk-operation failures used to go to
 *  console.warn, which desktop users never see. */
function DeployLogStrip({ wsId, profile }: DeployLogStripProps) {
  const [open, setOpen] = useState(false);
  const [, setTick] = useState(0);
  useEffect(() => {
    return subscribeDeployLog((changed) => {
      if (changed === wsId) setTick((n) => n + 1);
    });
  }, [wsId]);
  const entries = loadDeployLog(wsId);
  const failCount = entries.filter((e) => e.status === "fail").length;

  const retry = async (entry: DeployLogEntry) => {
    if (!entry.localPath) return;
    const p =
      profile && profile.id === entry.profileId
        ? profile
        : findSftpProfile(entry.profileId);
    if (!p) {
      toastError("The SFTP profile for this entry no longer exists.");
      return;
    }
    const link = lookupRemoteLink(wsId, entry.localPath) ?? {
      profileId: entry.profileId,
      remotePath: entry.remotePath,
      downloadedAt: 0,
    };
    const sent = await pushLinkedFile({
      wsId,
      conn: profileToConn(p),
      localPath: entry.localPath,
      link,
      mode: "interactive",
    });
    if (sent) toastSuccess(`Pushed → ${entry.remotePath}`);
  };

  return (
    <div className="deploy-log">
      <button
        className="deploy-log-toggle"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <Icon name={open ? "chevron-down" : "chevron-right"} size={11} />
        <span>Deploy log</span>
        {entries.length > 0 && (
          <span className="deploy-log-count">{entries.length}</span>
        )}
        {failCount > 0 && (
          <span className="deploy-log-failcount">{failCount} failed</span>
        )}
      </button>
      {open && (
        <div className="deploy-log-list">
          {entries.length === 0 && (
            <div className="deploy-log-empty">
              No transfers yet. Pushes, uploads, and downloads will be
              recorded here.
            </div>
          )}
          {entries.slice(0, 50).map((e) => (
            <div key={e.id} className={`deploy-log-row deploy-log-${e.status}`}>
              <span className="deploy-log-status" aria-hidden="true">
                {e.status === "ok" ? "✓" : e.status === "fail" ? "✗" : "⏭"}
              </span>
              <span
                className="deploy-log-main"
                title={`${e.op} ${e.remotePath}${e.detail ? `\n${e.detail}` : ""}`}
              >
                <span className="deploy-log-path">{e.remotePath}</span>
                <span className="deploy-log-sub">
                  {e.op} · {new Date(e.ts).toLocaleTimeString()}
                  {typeof e.bytes === "number"
                    ? ` · ${formatBytes(e.bytes)}`
                    : ""}
                  {e.detail ? ` · ${e.detail}` : ""}
                </span>
              </span>
              {e.status !== "ok" && e.localPath && (
                <button
                  className="deploy-log-retry"
                  onClick={() => void retry(e)}
                  title={`Push ${e.localPath} again`}
                >
                  Retry
                </button>
              )}
            </div>
          ))}
          {entries.length > 0 && (
            <button
              className="deploy-log-clear"
              onClick={() => clearDeployLog(wsId)}
            >
              Clear log
            </button>
          )}
        </div>
      )}
    </div>
  );
}

interface RemoteBreadcrumbProps {
  path: string;
  home: string;
  onJump: (path: string) => void;
}

/** Render an absolute remote path as clickable breadcrumb segments.
 *  Click any segment to drill up; the final segment is the current
 *  view (rendered as plain text, not a button). Includes a "🏠"
 *  shortcut back to home when we've drilled away from it. */
function RemoteBreadcrumb({ path, home, onJump }: RemoteBreadcrumbProps) {
  // Split absolute path into [/, /a, /a/b, /a/b/c] segments. Keep the
  // root slash as its own click target so the user can always go to /.
  const parts = path.split("/").filter(Boolean);
  const segments: { label: string; full: string }[] = [
    { label: "/", full: "/" },
  ];
  let acc = "";
  for (const p of parts) {
    acc += "/" + p;
    segments.push({ label: p, full: acc });
  }
  const showHome = path !== home;
  return (
    <div className="remote-breadcrumb">
      {showHome && (
        <button
          className="remote-bc-home"
          onClick={() => onJump(home)}
          title={`Jump to home (${home})`}
        >
          🏠
        </button>
      )}
      {segments.map((seg, i) => {
        const isLast = i === segments.length - 1;
        const isRoot = i === 0;
        return (
          <span key={seg.full} className="remote-bc-row">
            {!isRoot && <span className="remote-bc-sep">/</span>}
            {isLast ? (
              <span className="remote-bc-current">{seg.label}</span>
            ) : (
              <button
                className="remote-bc-segment"
                onClick={() => onJump(seg.full)}
                title={seg.full}
              >
                {seg.label}
              </button>
            )}
          </span>
        );
      })}
    </div>
  );
}

interface RemoteProfileFormProps {
  profile: SftpProfile;
  testMsg: { kind: "idle" | "testing" | "ok" | "fail"; text?: string };
  onChange: (next: SftpProfile) => void;
  onTest: () => void;
  onSave: () => void;
  onSaveAndConnect: () => void;
  onCancel: () => void;
  allowCancel: boolean;
}

function RemoteProfileForm({
  profile,
  testMsg,
  onChange,
  onTest,
  onSave,
  onSaveAndConnect,
  onCancel,
  allowCancel,
}: RemoteProfileFormProps) {
  const ready = profile.host.length > 0 && profile.user.length > 0;
  return (
    <div className="remote-form">
      <div className="remote-form-title">Add SFTP connection</div>
      <label className="remote-form-field">
        <span>Label</span>
        <input
          value={profile.name}
          placeholder="Production web server"
          onChange={(e) => onChange({ ...profile, name: e.target.value })}
        />
      </label>
      <label className="remote-form-field">
        <span>Host</span>
        <input
          value={profile.host}
          placeholder="example.com or 192.0.2.10"
          onChange={(e) => onChange({ ...profile, host: e.target.value })}
        />
      </label>
      <div className="remote-form-row">
        <label className="remote-form-field remote-form-field-port">
          <span>Port</span>
          <input
            type="number"
            min={1}
            max={65535}
            value={profile.port}
            onChange={(e) =>
              onChange({
                ...profile,
                port: Number(e.target.value) || 22,
              })
            }
          />
        </label>
        <label className="remote-form-field remote-form-field-user">
          <span>Username</span>
          <input
            value={profile.user}
            autoComplete="off"
            onChange={(e) => onChange({ ...profile, user: e.target.value })}
          />
        </label>
      </div>
      <label className="remote-form-field">
        <span>Password</span>
        <input
          type="password"
          value={profile.password}
          autoComplete="new-password"
          onChange={(e) => onChange({ ...profile, password: e.target.value })}
        />
      </label>
      <label className="remote-form-field">
        <span>Default folder (optional)</span>
        <input
          value={profile.defaultPath ?? ""}
          placeholder="/var/www/site (default: SSH home)"
          onChange={(e) =>
            onChange({ ...profile, defaultPath: e.target.value })
          }
        />
      </label>
      <label className="remote-form-field">
        <span>Private key path (optional)</span>
        <input
          value={profile.privateKeyPath ?? ""}
          placeholder="C:/Users/me/.ssh/id_ed25519 (leave blank for password)"
          onChange={(e) =>
            onChange({ ...profile, privateKeyPath: e.target.value })
          }
        />
      </label>

      <div className="remote-form-actions">
        <button
          className="remote-disconnect-btn"
          onClick={onTest}
          disabled={!ready || testMsg.kind === "testing"}
        >
          {testMsg.kind === "testing" ? "Testing…" : "Test"}
        </button>
        <button
          className="remote-disconnect-btn"
          onClick={onSave}
          disabled={!ready}
          title="Save without connecting"
        >
          Save
        </button>
        <button
          className="remote-connect-btn"
          onClick={onSaveAndConnect}
          disabled={!ready}
        >
          Save &amp; connect
        </button>
        {allowCancel && (
          <button className="remote-disconnect-btn" onClick={onCancel}>
            Cancel
          </button>
        )}
      </div>

      {testMsg.kind === "ok" && (
        <div className="remote-form-result remote-form-result-ok">
          <Icon name="check" size={12} /> {testMsg.text}
        </div>
      )}
      {testMsg.kind === "fail" && (
        <div className="remote-form-result remote-form-result-fail">
          <Icon name="x" size={12} /> {testMsg.text}
        </div>
      )}
    </div>
  );
}

interface RemoteDirChildrenProps {
  path: string;
  tree: Map<string, DirNode>;
  depth: number;
  onToggle: (parentPath: string, name: string) => Promise<void>;
  onOpenFile: (remotePath: string, name: string) => Promise<void>;
  onFileMenu: (e: React.MouseEvent, filePath: string, fileName: string) => void;
  onFolderMenu: (
    e: React.MouseEvent,
    folderPath: string,
    folderName: string,
  ) => void;
}

function RemoteDirChildren({
  path,
  tree,
  depth,
  onToggle,
  onOpenFile,
  onFileMenu,
  onFolderMenu,
}: RemoteDirChildrenProps) {
  const node = tree.get(path);
  if (!node) return null;
  if (node.entries === null) {
    return (
      <div
        className="remote-tree-loading"
        style={{ paddingLeft: depth * 14 + 12 }}
      >
        <span className="ai-spinner ai-spinner-sm" /> Loading…
      </div>
    );
  }
  if (node.entries.length === 0) {
    return (
      <div
        className="remote-tree-empty"
        style={{ paddingLeft: depth * 14 + 12 }}
      >
        (empty)
      </div>
    );
  }
  return (
    <>
      {node.entries.map((entry) => {
        const childPath = joinRemote(path, entry.name);
        const isDir = entry.kind === "dir";
        const isExpanded = isDir && node.expanded.has(entry.name);
        // Build a tooltip with the full remote path + size + mtime
        // so the user can hover any row to see when it was last changed
        // (useful for "did my push actually go through?" verification).
        const mtimeStr = entry.mtime
          ? new Date(entry.mtime * 1000).toLocaleString()
          : "(no mtime)";
        const sizeStr = isDir ? "" : `\nsize: ${formatBytes(entry.size)}`;
        const tip =
          `${childPath}\nmodified: ${mtimeStr}${sizeStr}\n` +
          (isDir
            ? "click to expand · right-click for actions"
            : "click to open · right-click for actions");
        return (
          <div key={entry.name}>
            <div
              className="tree-row remote-tree-row"
              style={{ paddingLeft: depth * 14 + 4 }}
              onClick={() => {
                if (isDir) {
                  void onToggle(path, entry.name);
                } else {
                  void onOpenFile(childPath, entry.name);
                }
              }}
              onContextMenu={(e) =>
                isDir
                  ? onFolderMenu(e, childPath, entry.name)
                  : onFileMenu(e, childPath, entry.name)
              }
              title={tip}
            >
              <span className="tree-caret">
                {isDir && (
                  <Icon
                    name={isExpanded ? "chevron-down" : "chevron-right"}
                    size={10}
                  />
                )}
              </span>
              <span className="tree-icon">
                <Icon
                  name={
                    isDir
                      ? "folder"
                      : entry.kind === "link"
                        ? "link"
                        : "file"
                  }
                  size={14}
                />
              </span>
              <span className="tree-name">{entry.name}</span>
              {!isDir && (
                <span className="remote-tree-size">
                  {formatBytes(entry.size)}
                </span>
              )}
            </div>
            {isDir && isExpanded && (
              <RemoteDirChildren
                path={childPath}
                tree={tree}
                depth={depth + 1}
                onToggle={onToggle}
                onOpenFile={onOpenFile}
                onFileMenu={onFileMenu}
                onFolderMenu={onFolderMenu}
              />
            )}
          </div>
        );
      })}
    </>
  );
}
