//! Atomic file writes — write to a sibling temp file then rename over
//! the target. Three modules (fs_ops, workspace, claude_mcp) used to
//! re-implement this with subtly different suffixes and error handling;
//! consolidated here so the rename-on-same-volume invariant + tmp
//! cleanup on rename failure is enforced once.
//!
//! All variants:
//!   1. Build a sibling tmp path (same parent → same volume → rename
//!      is atomic on every supported OS, Windows ≥2019 included).
//!   2. Write the contents to the tmp file.
//!   3. Rename the tmp file over the target. On rename failure, do a
//!      best-effort `remove_file` on the tmp so a crash mid-write
//!      doesn't leave clutter behind forever.

use std::path::Path;

const DEFAULT_SUFFIX: &str = ".codetta-tmp";

/// Write `contents` atomically to `path`. Creates parent directories
/// if needed. Uses the suffix ".codetta-tmp" so orphaned files after
/// a crash are easy to identify and clean up.
pub fn write(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    write_with_suffix(path, contents, DEFAULT_SUFFIX)
}

/// Write `contents` atomically with a caller-specified tmp suffix. The
/// suffix is appended to the full filename (so `state.json` →
/// `state.json{suffix}`), preserving the original extension. Avoids
/// the `with_extension` footgun where a path without an extension
/// would silently produce a different tmp name.
pub fn write_with_suffix(
    path: &Path,
    contents: &[u8],
    suffix: &str,
) -> std::io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut tmp = path.to_path_buf();
    let mut name = tmp
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(suffix);
    tmp.set_file_name(name);
    std::fs::write(&tmp, contents)?;
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}
