// SFTP support — first slice. Goals for this iteration:
//   - Test a connection profile (user proves credentials work)
//   - List a remote directory (foundation for the upcoming remote tree)
//   - Read / write a single remote file (foundation for edit-on-save)
//
// Out of scope for now: persistent connection pooling, ssh-key auth,
// recursive directory sync, conflict resolution. Profiles are stored
// frontend-side in localStorage; the backend is stateless and reconnects
// per call. That's slow but very simple — fast enough for the MVP UX
// where the user clicks Test, then occasionally browses the tree.
//
// russh is pure Rust so this compiles + runs on Windows without libssh2.

use async_trait::async_trait;
use russh::client;
use russh::keys::key::PublicKey;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Deserialize)]
pub struct SftpConnectArgs {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    /// Plain-text password. Stored in localStorage on the frontend (per
    /// the user's existing trust model — same as API keys live there).
    /// We don't currently support keyboard-interactive or key-based auth;
    /// add when there's a real demand for it.
    pub password: String,
}

fn default_port() -> u16 {
    22
}

#[derive(Debug, Serialize)]
pub struct SftpEntry {
    pub name: String,
    /// "dir" | "file" | "link" | "other"
    pub kind: String,
    pub size: u64,
    /// Unix epoch seconds. 0 if the server didn't report a mtime.
    pub mtime: u64,
}

/// All SFTP commands return Result<T, String> with a human-readable
/// error message — the frontend just renders it in a toast / inline
/// error. Wrapping every level of russh's error chain into structured
/// JSON would be more work than payoff for an MVP.
type SftpResult<T> = Result<T, String>;

struct AcceptAllKeysClient;

#[async_trait]
impl client::Handler for AcceptAllKeysClient {
    type Error = russh::Error;

    // For the MVP we trust-on-first-use without persisting fingerprints.
    // TODO when a known_hosts equivalent is added: prompt the user on
    // first connect, persist accepted fingerprints per-profile, and
    // fail-closed on mismatch (real MITM protection).
    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Open an SFTP session against the profile. Caller is responsible for
/// dropping the session when done — russh closes the channel on drop.
async fn open_session(args: &SftpConnectArgs) -> SftpResult<SftpSession> {
    let mut config = client::Config::default();
    // Reasonable defaults — the underlying TCP connect already has its
    // own timeout, but russh's keepalive helps detect dead servers.
    config.inactivity_timeout = Some(Duration::from_secs(30));
    let config = Arc::new(config);

    let mut session = client::connect(
        config,
        (args.host.as_str(), args.port),
        AcceptAllKeysClient,
    )
    .await
    .map_err(|e| format!("connect failed: {e}"))?;

    let auth = session
        .authenticate_password(&args.user, &args.password)
        .await
        .map_err(|e| format!("auth error: {e}"))?;
    if !auth {
        return Err("authentication failed (wrong username or password)".into());
    }

    let channel = session
        .channel_open_session()
        .await
        .map_err(|e| format!("channel open failed: {e}"))?;
    channel
        .request_subsystem(true, "sftp")
        .await
        .map_err(|e| format!("subsystem request failed: {e}"))?;
    let sftp = SftpSession::new(channel.into_stream())
        .await
        .map_err(|e| format!("sftp session failed: {e}"))?;
    Ok(sftp)
}

#[derive(Serialize)]
pub struct SftpTestResult {
    pub server_banner: String,
    pub home_dir: String,
    pub entry_count: usize,
}

#[tauri::command]
pub async fn sftp_test_connection(
    args: SftpConnectArgs,
) -> SftpResult<SftpTestResult> {
    let sftp = open_session(&args).await?;
    let home_dir = sftp
        .canonicalize(".")
        .await
        .map_err(|e| format!("canonicalize failed: {e}"))?;
    let entries = sftp
        .read_dir(&home_dir)
        .await
        .map_err(|e| format!("list home dir failed: {e}"))?;
    Ok(SftpTestResult {
        server_banner: format!("Connected as {} on {}:{}", args.user, args.host, args.port),
        home_dir,
        entry_count: entries.count(),
    })
}

#[derive(Debug, Deserialize)]
pub struct SftpListArgs {
    #[serde(flatten)]
    pub conn: SftpConnectArgs,
    pub path: String,
}

#[tauri::command]
pub async fn sftp_list_dir(args: SftpListArgs) -> SftpResult<Vec<SftpEntry>> {
    let sftp = open_session(&args.conn).await?;
    let entries = sftp
        .read_dir(&args.path)
        .await
        .map_err(|e| format!("list dir failed: {e}"))?;
    let mut out = Vec::new();
    for e in entries {
        let meta = e.metadata();
        let kind = if meta.is_dir() {
            "dir"
        } else if meta.is_regular() {
            "file"
        } else if meta.is_symlink() {
            "link"
        } else {
            "other"
        }
        .to_string();
        out.push(SftpEntry {
            name: e.file_name(),
            kind,
            size: meta.size.unwrap_or(0),
            mtime: meta.mtime.unwrap_or(0) as u64,
        });
    }
    out.sort_by(|a, b| match (a.kind.as_str(), b.kind.as_str()) {
        ("dir", "dir") | ("file", "file") => a.name.cmp(&b.name),
        ("dir", _) => std::cmp::Ordering::Less,
        (_, "dir") => std::cmp::Ordering::Greater,
        _ => a.name.cmp(&b.name),
    });
    Ok(out)
}

#[derive(Debug, Deserialize)]
pub struct SftpReadArgs {
    #[serde(flatten)]
    pub conn: SftpConnectArgs,
    pub path: String,
}

#[tauri::command]
pub async fn sftp_read_file(args: SftpReadArgs) -> SftpResult<String> {
    use tokio::io::AsyncReadExt;
    let sftp = open_session(&args.conn).await?;
    let mut file = sftp
        .open(&args.path)
        .await
        .map_err(|e| format!("open failed: {e}"))?;
    let mut buf = Vec::new();
    file.read_to_end(&mut buf)
        .await
        .map_err(|e| format!("read failed: {e}"))?;
    String::from_utf8(buf).map_err(|e| format!("file is not valid UTF-8: {e}"))
}

#[derive(Debug, Deserialize)]
pub struct SftpWriteArgs {
    #[serde(flatten)]
    pub conn: SftpConnectArgs,
    pub path: String,
    pub contents: String,
}

#[tauri::command]
pub async fn sftp_write_file(args: SftpWriteArgs) -> SftpResult<()> {
    use tokio::io::AsyncWriteExt;
    let sftp = open_session(&args.conn).await?;
    let mut file = sftp
        .create(&args.path)
        .await
        .map_err(|e| format!("create failed: {e}"))?;
    file.write_all(args.contents.as_bytes())
        .await
        .map_err(|e| format!("write failed: {e}"))?;
    file.shutdown()
        .await
        .map_err(|e| format!("close failed: {e}"))?;
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct SftpDeleteArgs {
    #[serde(flatten)]
    pub conn: SftpConnectArgs,
    pub path: String,
    pub is_dir: bool,
}

/// Delete a file or an empty directory. We don't recursively rm
/// folders for the MVP — too easy for a stray right-click to nuke
/// production. The frontend confirms via dialog before calling this.
#[tauri::command]
pub async fn sftp_delete(args: SftpDeleteArgs) -> SftpResult<()> {
    let sftp = open_session(&args.conn).await?;
    if args.is_dir {
        sftp.remove_dir(&args.path)
            .await
            .map_err(|e| format!("remove_dir failed: {e}"))?;
    } else {
        sftp.remove_file(&args.path)
            .await
            .map_err(|e| format!("remove_file failed: {e}"))?;
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct SftpMkdirArgs {
    #[serde(flatten)]
    pub conn: SftpConnectArgs,
    pub path: String,
}

#[tauri::command]
pub async fn sftp_mkdir(args: SftpMkdirArgs) -> SftpResult<()> {
    let sftp = open_session(&args.conn).await?;
    sftp.create_dir(&args.path)
        .await
        .map_err(|e| format!("create_dir failed: {e}"))?;
    Ok(())
}

// ---------- Recursive directory sync ----------
//
// Both directions (upload and download) reuse a single SSH session
// rather than reconnecting per file — connect-per-call would make a
// 500-file sync take minutes instead of seconds. Errors on individual
// entries are logged and counted but don't abort the whole sync; the
// summary returned to the frontend reports successes + failures.

#[derive(Debug, Deserialize)]
pub struct SftpUploadDirArgs {
    #[serde(flatten)]
    pub conn: SftpConnectArgs,
    pub local_path: String,
    pub remote_path: String,
}

#[derive(Serialize)]
pub struct SftpSyncResult {
    pub files: usize,
    pub bytes: u64,
    pub failed: Vec<String>,
}

const MAX_SYNC_BYTES: u64 = 50 * 1024 * 1024;
const MAX_SYNC_FILES: usize = 5000;

fn walk_local_dir(root: &std::path::Path) -> std::io::Result<Vec<(std::path::PathBuf, bool)>> {
    // Returns (absolute_path, is_dir) in BFS order so directories are
    // listed before their contents — lets the upload caller mkdir each
    // remote dir before writing files into it.
    let mut out: Vec<(std::path::PathBuf, bool)> = Vec::new();
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            // Skip the same heavy dirs the file-walker uses; spamming
            // node_modules over SFTP is almost never what the user wants.
            if meta.is_dir() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if matches!(
                    name.as_str(),
                    ".git" | "node_modules" | "target" | "dist" | "build"
                        | ".next" | ".turbo" | ".cache" | "out" | ".venv"
                        | "__pycache__" | ".codetta-remote-cache"
                ) {
                    continue;
                }
                out.push((path.clone(), true));
                stack.push(path);
            } else {
                out.push((path, false));
            }
        }
    }
    Ok(out)
}

fn relative_to(base: &std::path::Path, p: &std::path::Path) -> String {
    p.strip_prefix(base)
        .map(|r| r.to_string_lossy().replace('\\', "/"))
        .unwrap_or_else(|_| p.to_string_lossy().to_string())
}

#[tauri::command]
pub async fn sftp_upload_dir(args: SftpUploadDirArgs) -> SftpResult<SftpSyncResult> {
    use tokio::io::AsyncWriteExt;
    let local_root = std::path::PathBuf::from(&args.local_path);
    if !local_root.is_dir() {
        return Err(format!("not a local directory: {}", args.local_path));
    }
    let entries = walk_local_dir(&local_root).map_err(|e| e.to_string())?;
    if entries.len() > MAX_SYNC_FILES {
        return Err(format!(
            "too many entries ({} > {}). Pick a smaller folder.",
            entries.len(),
            MAX_SYNC_FILES
        ));
    }
    let sftp = open_session(&args.conn).await?;
    let remote_root = args.remote_path.trim_end_matches('/').to_string();
    // mkdir the remote root if it doesn't exist; ignore failure (often
    // just "already exists").
    let _ = sftp.create_dir(&remote_root).await;

    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut failed: Vec<String> = Vec::new();
    for (abs, is_dir) in entries {
        let rel = relative_to(&local_root, &abs);
        let remote = format!("{}/{}", remote_root, rel);
        if is_dir {
            // Best-effort mkdir; SFTP returns an error for existing dirs.
            let _ = sftp.create_dir(&remote).await;
            continue;
        }
        let buf = match std::fs::read(&abs) {
            Ok(b) => b,
            Err(e) => {
                failed.push(format!("{}: read {}", rel, e));
                continue;
            }
        };
        if (bytes + buf.len() as u64) > MAX_SYNC_BYTES {
            return Err(format!(
                "transfer would exceed {} MB cap. Sent {} files / {} bytes before stopping.",
                MAX_SYNC_BYTES / 1024 / 1024,
                files,
                bytes
            ));
        }
        let mut file = match sftp.create(&remote).await {
            Ok(f) => f,
            Err(e) => {
                failed.push(format!("{}: create {}", rel, e));
                continue;
            }
        };
        if let Err(e) = file.write_all(&buf).await {
            failed.push(format!("{}: write {}", rel, e));
            continue;
        }
        if let Err(e) = file.shutdown().await {
            failed.push(format!("{}: close {}", rel, e));
            continue;
        }
        files += 1;
        bytes += buf.len() as u64;
    }
    Ok(SftpSyncResult { files, bytes, failed })
}

#[derive(Debug, Deserialize)]
pub struct SftpDownloadDirArgs {
    #[serde(flatten)]
    pub conn: SftpConnectArgs,
    pub remote_path: String,
    pub local_path: String,
}

#[tauri::command]
pub async fn sftp_download_dir(args: SftpDownloadDirArgs) -> SftpResult<SftpSyncResult> {
    use tokio::io::AsyncReadExt;
    let local_root = std::path::PathBuf::from(&args.local_path);
    std::fs::create_dir_all(&local_root)
        .map_err(|e| format!("create local dir failed: {e}"))?;
    let sftp = open_session(&args.conn).await?;
    let remote_root = args.remote_path.trim_end_matches('/').to_string();

    // Walk remote in BFS so we mkdir parents before fetching their files.
    // Each entry: (full remote path, relative path from remote_root, is_dir).
    let mut to_visit: Vec<String> = vec![remote_root.clone()];
    let mut all: Vec<(String, String, bool)> = Vec::new();
    while let Some(dir) = to_visit.pop() {
        if all.len() > MAX_SYNC_FILES {
            return Err(format!(
                "too many entries (>{}). Pick a smaller folder.",
                MAX_SYNC_FILES
            ));
        }
        let entries = sftp
            .read_dir(&dir)
            .await
            .map_err(|e| format!("list {} failed: {e}", dir))?;
        for e in entries {
            let name = e.file_name();
            let full = format!("{}/{}", dir.trim_end_matches('/'), name);
            let rel = full
                .strip_prefix(&format!("{}/", remote_root))
                .map(|s| s.to_string())
                .unwrap_or_else(|| name.clone());
            let meta = e.metadata();
            if meta.is_dir() {
                all.push((full.clone(), rel, true));
                to_visit.push(full);
            } else if meta.is_regular() {
                all.push((full, rel, false));
            }
            // links + others: skip silently for MVP
        }
    }

    let mut files = 0usize;
    let mut bytes = 0u64;
    let mut failed: Vec<String> = Vec::new();
    for (full, rel, is_dir) in all {
        let local_target = local_root.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
        if is_dir {
            let _ = std::fs::create_dir_all(&local_target);
            continue;
        }
        // Make sure parent exists (for files in subdirs we walked but
        // their dir entry may not have been mkdir-ed yet).
        if let Some(parent) = local_target.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let mut file = match sftp.open(&full).await {
            Ok(f) => f,
            Err(e) => {
                failed.push(format!("{}: open {}", rel, e));
                continue;
            }
        };
        let mut buf = Vec::new();
        if let Err(e) = file.read_to_end(&mut buf).await {
            failed.push(format!("{}: read {}", rel, e));
            continue;
        }
        if (bytes + buf.len() as u64) > MAX_SYNC_BYTES {
            return Err(format!(
                "transfer would exceed {} MB cap. Got {} files / {} bytes before stopping.",
                MAX_SYNC_BYTES / 1024 / 1024,
                files,
                bytes
            ));
        }
        if let Err(e) = std::fs::write(&local_target, &buf) {
            failed.push(format!("{}: write {}", rel, e));
            continue;
        }
        files += 1;
        bytes += buf.len() as u64;
    }
    Ok(SftpSyncResult { files, bytes, failed })
}
