// SFTP support. Provides a small pure-Rust SSH/SFTP layer (russh +
// russh-sftp) wired up to Tauri commands the frontend invokes for
// browsing, file edit-on-save, and recursive directory sync.
//
// Architecture:
//   - SftpPoolState holds a HashMap<pool_key, Arc<Mutex<SftpSession>>>
//     keyed by host:port:user, so the same profile reuses one live SSH
//     channel across all calls. Without pooling, browsing a tree would
//     reconnect (TCP + key exchange + auth + channel open + sftp
//     subsystem) on every list_dir / read_file — easily 1-2 seconds
//     per click on a high-latency link. Pooled, only the first call
//     pays that cost; subsequent ones piggyback the open channel.
//   - On any operation error, the cached session is evicted so the
//     next call reconnects. Cheaper than trying to detect "is this
//     session still healthy?" up front.
//   - Auth supports password OR SSH private key (PEM); the key path
//     is optional on the profile. Empty path → password auth.
//
// russh is pure Rust so this compiles + runs on Windows without
// libssh2 / native deps.

use async_trait::async_trait;
use russh::client;
use russh::keys::key::PublicKey;
use russh_sftp::client::SftpSession;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::Mutex as AsyncMutex;

#[derive(Debug, Deserialize, Clone)]
pub struct SftpConnectArgs {
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    pub user: String,
    /// Plain-text password. Used for password auth. When `private_key_path`
    /// is set + non-empty AND points to an unencrypted (or
    /// PASSWORD-encrypted) key file, the password doubles as the key's
    /// passphrase. Empty + no key path → connect attempt fails.
    pub password: String,
    /// Optional absolute path to an OpenSSH private key (PEM). When set,
    /// key auth is tried first; a successful key auth wins, otherwise we
    /// fall through to password auth so existing profiles keep working.
    #[serde(default)]
    pub private_key_path: Option<String>,
}

impl SftpConnectArgs {
    /// Pool key — stable per profile (host + port + user). Password and
    /// key path are deliberately excluded so a re-saved profile with the
    /// same auth surface reuses the cached session. If the user changes
    /// host/port/user, that's a different connection and gets its own
    /// pool entry; a password change merely resets when the existing
    /// session eventually drops.
    fn pool_key(&self) -> String {
        format!("{}@{}:{}", self.user, self.host, self.port)
    }
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

type SftpResult<T> = Result<T, String>;

/// One pooled SFTP session. The async mutex serialises calls so concurrent
/// frontend operations don't interleave reads/writes on the same SSH
/// channel — russh-sftp itself is not safe for that.
type PooledSession = Arc<AsyncMutex<SftpSession>>;

#[derive(Default)]
pub struct SftpPoolState {
    sessions: parking_lot::Mutex<HashMap<String, PooledSession>>,
}

struct AcceptAllKeysClient;

#[async_trait]
impl client::Handler for AcceptAllKeysClient {
    type Error = russh::Error;

    // Trust-on-first-use without persisting fingerprints. TODO known_hosts.
    async fn check_server_key(
        &mut self,
        _server_public_key: &PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Open a fresh SFTP session, trying SSH key auth first if a key path
/// is configured, then falling back to password. Returns the live
/// session — caller decides whether to pool it or use it one-shot.
async fn open_session(args: &SftpConnectArgs) -> SftpResult<SftpSession> {
    let config = Arc::new(client::Config {
        inactivity_timeout: Some(Duration::from_secs(30)),
        ..client::Config::default()
    });

    let mut session = client::connect(
        config,
        (args.host.as_str(), args.port),
        AcceptAllKeysClient,
    )
    .await
    .map_err(|e| format!("connect failed: {e}"))?;

    let mut authed = false;

    // Try key auth first when a key path is set + non-empty.
    if let Some(path) = args
        .private_key_path
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        match russh::keys::load_secret_key(
            path,
            if args.password.is_empty() {
                None
            } else {
                Some(args.password.as_str())
            },
        ) {
            Ok(key) => {
                let key_arc = Arc::new(key);
                match session
                    .authenticate_publickey(&args.user, key_arc)
                    .await
                {
                    Ok(true) => authed = true,
                    Ok(false) => {
                        // Key parsed but server rejected it. Fall through
                        // to password — many servers accept either.
                    }
                    Err(e) => return Err(format!("key auth error: {e}")),
                }
            }
            Err(e) => {
                return Err(format!(
                    "could not load private key at {}: {} (check the path and the passphrase)",
                    path, e
                ));
            }
        }
    }

    if !authed {
        if args.password.is_empty() && args.private_key_path.is_none() {
            return Err("no password and no private key configured".into());
        }
        let ok = session
            .authenticate_password(&args.user, &args.password)
            .await
            .map_err(|e| format!("auth error: {e}"))?;
        if !ok {
            return Err("authentication failed (wrong username, password, or key)".into());
        }
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

/// Get a pooled session for this profile. Returns the existing one if
/// it's still in the pool; otherwise opens fresh and caches.
async fn get_session(
    state: &SftpPoolState,
    args: &SftpConnectArgs,
) -> SftpResult<PooledSession> {
    let key = args.pool_key();
    {
        let pool = state.sessions.lock();
        if let Some(s) = pool.get(&key) {
            return Ok(s.clone());
        }
    }
    let session = open_session(args).await?;
    let arc: PooledSession = Arc::new(AsyncMutex::new(session));
    state.sessions.lock().insert(key, arc.clone());
    Ok(arc)
}

/// Drop the cached session for this profile. Called after any
/// operation error so the next call reconnects rather than reusing a
/// dead channel. Also called by `sftp_disconnect`.
fn evict_session(state: &SftpPoolState, args: &SftpConnectArgs) {
    state.sessions.lock().remove(&args.pool_key());
}

#[derive(Serialize)]
pub struct SftpTestResult {
    pub server_banner: String,
    pub home_dir: String,
    pub entry_count: usize,
}

#[tauri::command]
pub async fn sftp_test_connection(
    state: tauri::State<'_, SftpPoolState>,
    args: SftpConnectArgs,
) -> SftpResult<SftpTestResult> {
    // Test always opens a fresh session and pools it on success — so
    // the user's "Test" click both validates the credentials AND warms
    // up the pool for the immediately-following Connect.
    let session = match get_session(&state, &args).await {
        Ok(s) => s,
        Err(e) => {
            evict_session(&state, &args);
            return Err(e);
        }
    };
    let sftp = session.lock().await;
    let home_dir = match sftp.canonicalize(".").await {
        Ok(p) => p,
        Err(e) => {
            drop(sftp);
            evict_session(&state, &args);
            return Err(format!("canonicalize failed: {e}"));
        }
    };
    let entries = match sftp.read_dir(&home_dir).await {
        Ok(e) => e,
        Err(e) => {
            drop(sftp);
            evict_session(&state, &args);
            return Err(format!("list home dir failed: {e}"));
        }
    };
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
pub async fn sftp_list_dir(
    state: tauri::State<'_, SftpPoolState>,
    args: SftpListArgs,
) -> SftpResult<Vec<SftpEntry>> {
    let session = get_session(&state, &args.conn).await?;
    let sftp = session.lock().await;
    let entries = match sftp.read_dir(&args.path).await {
        Ok(e) => e,
        Err(e) => {
            drop(sftp);
            evict_session(&state, &args.conn);
            return Err(format!("list dir failed: {e}"));
        }
    };
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
pub async fn sftp_read_file(
    state: tauri::State<'_, SftpPoolState>,
    args: SftpReadArgs,
) -> SftpResult<String> {
    use tokio::io::AsyncReadExt;
    let session = get_session(&state, &args.conn).await?;
    let sftp = session.lock().await;
    let mut file = match sftp.open(&args.path).await {
        Ok(f) => f,
        Err(e) => {
            drop(sftp);
            evict_session(&state, &args.conn);
            return Err(format!("open failed: {e}"));
        }
    };
    let mut buf = Vec::new();
    if let Err(e) = file.read_to_end(&mut buf).await {
        drop(file);
        drop(sftp);
        evict_session(&state, &args.conn);
        return Err(format!("read failed: {e}"));
    }
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
pub async fn sftp_write_file(
    state: tauri::State<'_, SftpPoolState>,
    args: SftpWriteArgs,
) -> SftpResult<()> {
    use tokio::io::AsyncWriteExt;
    let session = get_session(&state, &args.conn).await?;
    let sftp = session.lock().await;
    let mut file = match sftp.create(&args.path).await {
        Ok(f) => f,
        Err(e) => {
            drop(sftp);
            evict_session(&state, &args.conn);
            return Err(format!("create failed: {e}"));
        }
    };
    if let Err(e) = file.write_all(args.contents.as_bytes()).await {
        drop(file);
        drop(sftp);
        evict_session(&state, &args.conn);
        return Err(format!("write failed: {e}"));
    }
    if let Err(e) = file.shutdown().await {
        drop(file);
        drop(sftp);
        evict_session(&state, &args.conn);
        return Err(format!("close failed: {e}"));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
pub struct SftpDeleteArgs {
    #[serde(flatten)]
    pub conn: SftpConnectArgs,
    pub path: String,
    pub is_dir: bool,
}

/// Delete a file or an empty directory. The frontend gates this with
/// a type-to-confirm dialog for folders.
#[tauri::command]
pub async fn sftp_delete(
    state: tauri::State<'_, SftpPoolState>,
    args: SftpDeleteArgs,
) -> SftpResult<()> {
    let session = get_session(&state, &args.conn).await?;
    let sftp = session.lock().await;
    let r = if args.is_dir {
        sftp.remove_dir(&args.path).await
    } else {
        sftp.remove_file(&args.path).await
    };
    if let Err(e) = r {
        drop(sftp);
        evict_session(&state, &args.conn);
        return Err(format!("delete failed: {e}"));
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
pub async fn sftp_mkdir(
    state: tauri::State<'_, SftpPoolState>,
    args: SftpMkdirArgs,
) -> SftpResult<()> {
    let session = get_session(&state, &args.conn).await?;
    let sftp = session.lock().await;
    if let Err(e) = sftp.create_dir(&args.path).await {
        drop(sftp);
        evict_session(&state, &args.conn);
        return Err(format!("create_dir failed: {e}"));
    }
    Ok(())
}

/// Drop the cached session for this connection. Called by the frontend
/// when the user clicks Disconnect — frees the SSH channel so the
/// remote server can reclaim the slot.
#[tauri::command]
pub async fn sftp_disconnect(
    state: tauri::State<'_, SftpPoolState>,
    args: SftpConnectArgs,
) -> SftpResult<()> {
    evict_session(&state, &args);
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
            // The list lives in search.rs as the authoritative copy. We
            // also skip our own remote-cache directory (.codetta-remote-cache)
            // which is sftp-specific and not in the shared list.
            if meta.is_dir() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name == ".codetta-remote-cache"
                    || crate::search::HEAVY_DIRS
                        .iter()
                        .any(|h| h.eq_ignore_ascii_case(&name))
                {
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
pub async fn sftp_upload_dir(
    state: tauri::State<'_, SftpPoolState>,
    args: SftpUploadDirArgs,
) -> SftpResult<SftpSyncResult> {
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
    let session = get_session(&state, &args.conn).await?;
    let sftp = session.lock().await;
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
pub async fn sftp_download_dir(
    state: tauri::State<'_, SftpPoolState>,
    args: SftpDownloadDirArgs,
) -> SftpResult<SftpSyncResult> {
    use tokio::io::AsyncReadExt;
    let local_root = std::path::PathBuf::from(&args.local_path);
    std::fs::create_dir_all(&local_root)
        .map_err(|e| format!("create local dir failed: {e}"))?;
    let session = get_session(&state, &args.conn).await?;
    let sftp = session.lock().await;
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
