use serde::Serialize;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
pub struct DirEntry {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

const HEAVY_DIRS: &[&str] = &[
    "node_modules",
    ".git",
    "target",
    "dist",
    "build",
    ".next",
    ".turbo",
    ".cache",
    "out",
    ".venv",
    "__pycache__",
];

const MAX_READ_BYTES: u64 = 8 * 1024 * 1024; // 8 MiB
const BINARY_PROBE_BYTES: usize = 8 * 1024;

#[tauri::command]
pub fn list_dir(path: String) -> Result<Vec<DirEntry>, String> {
    let p = Path::new(&path);
    let mut out = Vec::new();
    let read = std::fs::read_dir(p).map_err(|e| e.to_string())?;
    for entry in read.flatten() {
        let meta = match entry.metadata() {
            Ok(m) => m,
            Err(_) => continue,
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let is_dir = meta.is_dir();
        if is_dir && HEAVY_DIRS.iter().any(|h| h.eq_ignore_ascii_case(&name)) {
            // Still show the dir but it won't be auto-traversed; users can expand it manually.
            // We still include it so users who *want* to look inside can.
        }
        out.push(DirEntry {
            name,
            path: entry.path().to_string_lossy().into_owned(),
            is_dir,
        });
    }
    out.sort_by(|a, b| match (a.is_dir, b.is_dir) {
        (true, false) => std::cmp::Ordering::Less,
        (false, true) => std::cmp::Ordering::Greater,
        _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
    });
    Ok(out)
}

fn looks_binary(buf: &[u8]) -> bool {
    // Heuristic: if there's a NUL in the first probe, treat as binary
    buf.iter().take(BINARY_PROBE_BYTES).any(|b| *b == 0)
}

#[tauri::command]
pub fn read_file(path: String) -> Result<String, String> {
    let p = Path::new(&path);
    let meta = std::fs::metadata(p).map_err(|e| e.to_string())?;
    if meta.len() > MAX_READ_BYTES {
        return Err(format!(
            "File is too large to open in editor ({} MiB > {} MiB).",
            meta.len() / (1024 * 1024),
            MAX_READ_BYTES / (1024 * 1024)
        ));
    }
    let bytes = std::fs::read(p).map_err(|e| e.to_string())?;
    if looks_binary(&bytes) {
        return Err("File appears to be binary.".to_string());
    }
    Ok(decode_text_bytes(&bytes))
}

/// Decode arbitrary text bytes, tolerating common non-UTF-8 encodings
/// (GBK / GB2312 / Big5 / Shift-JIS / EUC-KR / Windows-125x). Strategy:
///   1. Strip UTF-8 BOM if present and the rest is valid UTF-8.
///   2. Honour explicit UTF-16 BOMs.
///   3. Try plain UTF-8.
///   4. Fall back to chardetng + encoding_rs for everything else.
/// Always returns a String — never errors. Garbage in → "best-guess"
/// out, which is exactly how every other editor handles legacy files.
fn decode_text_bytes(bytes: &[u8]) -> String {
    // 1. UTF-8 BOM (EF BB BF).
    if bytes.starts_with(&[0xEF, 0xBB, 0xBF]) {
        if let Ok(s) = std::str::from_utf8(&bytes[3..]) {
            return s.to_string();
        }
    }
    // 2. UTF-16 LE / BE BOMs.
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (cow, _, _) = encoding_rs::UTF_16LE.decode(&bytes[2..]);
        return cow.into_owned();
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (cow, _, _) = encoding_rs::UTF_16BE.decode(&bytes[2..]);
        return cow.into_owned();
    }
    // 3. Plain UTF-8 — most files.
    if let Ok(s) = std::str::from_utf8(bytes) {
        return s.to_string();
    }
    // 4. Sniff legacy encoding (GBK, Shift_JIS, etc.) and decode.
    let mut detector = chardetng::EncodingDetector::new();
    detector.feed(bytes, true);
    let encoding = detector.guess(None, true);
    let (cow, _, _) = encoding.decode(bytes);
    cow.into_owned()
}

fn write_atomic(path: &Path, contents: &[u8]) -> std::io::Result<()> {
    let parent = path.parent().unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)?;
    let mut tmp = path.to_path_buf();
    let mut name = tmp
        .file_name()
        .map(|s| s.to_os_string())
        .unwrap_or_default();
    name.push(".lcp.tmp");
    tmp.set_file_name(name);
    std::fs::write(&tmp, contents)?;
    // std::fs::rename atomically replaces the target on Windows (>=2019/Rust >=1.49) and Unix.
    match std::fs::rename(&tmp, path) {
        Ok(()) => Ok(()),
        Err(e) => {
            let _ = std::fs::remove_file(&tmp);
            Err(e)
        }
    }
}

#[tauri::command]
pub fn write_file(path: String, contents: String) -> Result<(), String> {
    write_atomic(Path::new(&path), contents.as_bytes()).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn rename_path(from: String, to: String) -> Result<(), String> {
    std::fs::rename(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn delete_path(path: String) -> Result<(), String> {
    let p = Path::new(&path);
    if p.is_dir() {
        std::fs::remove_dir_all(p).map_err(|e| e.to_string())
    } else {
        std::fs::remove_file(p).map_err(|e| e.to_string())
    }
}

#[tauri::command]
pub fn create_dir(path: String) -> Result<(), String> {
    std::fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn path_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
pub fn create_file(path: String) -> Result<(), String> {
    let p = PathBuf::from(&path);
    if let Some(parent) = p.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    if p.exists() {
        return Err("File already exists".to_string());
    }
    std::fs::write(&p, "").map_err(|e| e.to_string())
}
