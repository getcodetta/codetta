use serde::Serialize;
use std::io::Read;
use std::path::Path;

/// Directory names that file walkers should skip — package caches, build
/// outputs, framework state, virtual envs, IDE state. Public so other
/// modules (sftp upload, future indexers) can reuse the same list
/// instead of inlining their own drift-prone copy.
pub const HEAVY_DIRS: &[&str] = &[
    // Package managers
    "node_modules",
    ".pnpm-store",
    "vendor", // PHP Composer, Go vendor
    // VCS / system
    ".git",
    ".hg",
    ".svn",
    // Build outputs
    "target", // Rust, Java/Maven
    "dist",
    "build",
    "out",
    "coverage",
    ".nyc_output",
    // Framework caches
    ".next",
    ".nuxt",
    ".turbo",
    ".cache",
    ".vercel",
    ".svelte-kit",
    ".angular",
    ".astro",
    ".docusaurus",
    ".parcel-cache",
    ".gradle",
    // Python
    ".venv",
    "venv",
    "__pycache__",
    ".tox",
    ".mypy_cache",
    ".ruff_cache",
    ".pytest_cache",
    // IDE state
    ".idea",
];

const MAX_FILE_BYTES_FOR_SEARCH: u64 = 2 * 1024 * 1024;
const BINARY_PROBE: usize = 8 * 1024;

fn is_heavy_dir(name: &str) -> bool {
    HEAVY_DIRS.iter().any(|h| h.eq_ignore_ascii_case(name))
}

fn looks_binary(buf: &[u8]) -> bool {
    // Caller passes only the first BINARY_PROBE bytes (read_text_file_capped
    // probes ahead of any decision), so a NUL anywhere in the buffer is
    // treated as a binary indicator.
    buf.iter().any(|b| *b == 0)
}

/// Two-stage read: probe the first BINARY_PROBE bytes for NUL, bail
/// early if it looks binary, otherwise read the full file. Returns None
/// for files that are too big, fail to open, or look binary — every
/// failure mode the search/scan loops want to skip silently. Saves up to
/// MAX_FILE_BYTES_FOR_SEARCH per binary file we'd otherwise read in full
/// just to discard.
fn read_text_file_capped(path: &Path, max_bytes: u64) -> Option<Vec<u8>> {
    let meta = std::fs::metadata(path).ok()?;
    if meta.len() > max_bytes {
        return None;
    }
    let mut f = std::fs::File::open(path).ok()?;
    let mut probe = vec![0u8; BINARY_PROBE];
    let probed = f.read(&mut probe).ok()?;
    probe.truncate(probed);
    if looks_binary(&probe) {
        return None;
    }
    let total = meta.len() as usize;
    let mut bytes = Vec::with_capacity(total.max(probed));
    bytes.extend_from_slice(&probe);
    f.read_to_end(&mut bytes).ok()?;
    Some(bytes)
}

fn walk_files<F: FnMut(&Path) -> bool>(
    root: &Path,
    out: &mut Vec<String>,
    max: usize,
    mut filter: F,
) {
    let mut stack: Vec<std::path::PathBuf> = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        if out.len() >= max {
            return;
        }
        let read = match std::fs::read_dir(&dir) {
            Ok(r) => r,
            Err(_) => continue,
        };
        for entry in read.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            let path = entry.path();
            let meta = match entry.metadata() {
                Ok(m) => m,
                Err(_) => continue,
            };
            if meta.is_dir() {
                if is_heavy_dir(&name) {
                    continue;
                }
                stack.push(path);
            } else if filter(&path) {
                out.push(path.to_string_lossy().into_owned());
                if out.len() >= max {
                    return;
                }
            }
        }
    }
}

#[tauri::command]
pub fn list_workspace_files(
    root: String,
    max: Option<usize>,
) -> Result<Vec<String>, String> {
    let cap = max.unwrap_or(5000);
    let mut out = Vec::new();
    walk_files(Path::new(&root), &mut out, cap, |_p| true);
    Ok(out)
}

#[derive(Serialize)]
pub struct SearchHit {
    pub path: String,
    pub line: usize,
    pub col: usize,
    pub text: String,
}

#[tauri::command]
pub fn search_text(
    root: String,
    query: String,
    case_sensitive: Option<bool>,
    max_results: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let cs = case_sensitive.unwrap_or(false);
    let needle = if cs { query.clone() } else { query.to_lowercase() };
    let cap = max_results.unwrap_or(2000);

    let mut paths: Vec<String> = Vec::new();
    walk_files(Path::new(&root), &mut paths, 50_000, |_p| true);

    let mut hits = Vec::new();
    for p in paths {
        if hits.len() >= cap {
            break;
        }
        let pp = Path::new(&p);
        let bytes = match read_text_file_capped(pp, MAX_FILE_BYTES_FOR_SEARCH) {
            Some(b) => b,
            None => continue,
        };
        let text = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => continue,
        };
        for (i, line) in text.lines().enumerate() {
            let hay = if cs {
                line.to_string()
            } else {
                line.to_lowercase()
            };
            if let Some(col) = hay.find(&needle) {
                hits.push(SearchHit {
                    path: p.clone(),
                    line: i + 1,
                    col: col + 1,
                    text: line.to_string(),
                });
                if hits.len() >= cap {
                    break;
                }
            }
        }
    }

    Ok(hits)
}

#[derive(Serialize)]
pub struct TodoHit {
    pub path: String,
    pub line: usize,
    pub kind: String,
    pub text: String,
}

// Files that frequently contain text but never meaningful TODOs.
// Generated, minified, or lock files — skip outright.
fn is_noise_filename(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    if n.ends_with(".min.js") || n.ends_with(".min.css") {
        return true;
    }
    if n.ends_with(".map") || n.ends_with(".lock") {
        return true;
    }
    matches!(
        n.as_str(),
        "package-lock.json"
            | "yarn.lock"
            | "pnpm-lock.yaml"
            | "bun.lockb"
            | "cargo.lock"
            | "composer.lock"
            | "gemfile.lock"
            | "poetry.lock"
            | "go.sum"
    )
}

// Extensions where source-comment TODOs make sense. Anything else is
// skipped to keep scans fast on large repos. Generous on purpose so
// users don't lose TODOs in less common languages.
fn has_scannable_ext(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    let dot = match lower.rfind('.') {
        Some(i) => i,
        None => return false,
    };
    matches!(
        &lower[dot..],
        ".ts"
            | ".tsx"
            | ".js"
            | ".jsx"
            | ".mjs"
            | ".cjs"
            | ".vue"
            | ".svelte"
            | ".astro"
            | ".rs"
            | ".go"
            | ".py"
            | ".pyi"
            | ".rb"
            | ".php"
            | ".java"
            | ".kt"
            | ".kts"
            | ".scala"
            | ".swift"
            | ".m"
            | ".mm"
            | ".c"
            | ".h"
            | ".cc"
            | ".cpp"
            | ".cxx"
            | ".hpp"
            | ".hh"
            | ".cs"
            | ".lua"
            | ".dart"
            | ".elm"
            | ".ex"
            | ".exs"
            | ".erl"
            | ".clj"
            | ".cljs"
            | ".nim"
            | ".zig"
            | ".sh"
            | ".bash"
            | ".zsh"
            | ".fish"
            | ".ps1"
            | ".sql"
            | ".css"
            | ".scss"
            | ".sass"
            | ".less"
            | ".html"
            | ".htm"
            | ".xml"
            | ".yaml"
            | ".yml"
            | ".toml"
            | ".md"
            | ".markdown"
            | ".rst"
            | ".tex"
    )
}

const MAX_TODO_FILE_BYTES: u64 = 1024 * 1024;
const MAX_TODO_WALK: usize = 30_000;

fn scan_todos_blocking(root: String, cap: usize) -> Vec<TodoHit> {
    let mut paths: Vec<String> = Vec::new();
    walk_files(Path::new(&root), &mut paths, MAX_TODO_WALK, |p| {
        match p.file_name().and_then(|n| n.to_str()) {
            Some(name) => has_scannable_ext(name) && !is_noise_filename(name),
            None => false,
        }
    });

    let kinds: &[&str] = &["TODO", "FIXME", "XXX", "HACK", "NOTE"];
    let mut hits = Vec::with_capacity(cap.min(512));

    'outer: for p in paths {
        let pp = Path::new(&p);
        let bytes = match read_text_file_capped(pp, MAX_TODO_FILE_BYTES) {
            Some(b) => b,
            None => continue,
        };
        let text = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => continue,
        };
        // Cheap pre-check: if the whole file doesn't contain "O" in
        // an obvious keyword position, skip. (TODO/FIXME/XXX/HACK/NOTE
        // all share at least one uppercase letter that's rare in code.)
        // Skip the per-line cost entirely when nothing matches.
        if !text.bytes().any(|b| matches!(b, b'T' | b'F' | b'X' | b'H' | b'N')) {
            continue;
        }
        for (i, line) in text.lines().enumerate() {
            for kind in kinds {
                if let Some(idx) = line.find(kind) {
                    let prev = if idx == 0 {
                        None
                    } else {
                        line.as_bytes().get(idx - 1).copied()
                    };
                    let ok = match prev {
                        None => true,
                        Some(b) => !(b.is_ascii_alphanumeric() || b == b'_'),
                    };
                    if !ok {
                        continue;
                    }
                    let after = &line[idx + kind.len()..];
                    let trimmed = after.trim_start_matches(|c: char| {
                        c == ':' || c == ' ' || c == '\t' || c == '(' || c == ')'
                    });
                    hits.push(TodoHit {
                        path: p.clone(),
                        line: i + 1,
                        kind: (*kind).into(),
                        text: trimmed.trim().to_string(),
                    });
                    if hits.len() >= cap {
                        break 'outer;
                    }
                    break;
                }
            }
        }
    }
    hits
}

#[tauri::command]
pub async fn scan_todos(
    root: String,
    max_results: Option<usize>,
) -> Result<Vec<TodoHit>, String> {
    let cap = max_results.unwrap_or(2000);
    tauri::async_runtime::spawn_blocking(move || scan_todos_blocking(root, cap))
        .await
        .map_err(|e| e.to_string())
}

#[derive(Serialize)]
pub struct PackageScript {
    pub name: String,
    pub command: String,
}

#[tauri::command]
pub fn read_package_scripts(root: String) -> Result<Vec<PackageScript>, String> {
    let path = Path::new(&root).join("package.json");
    if !path.exists() {
        return Ok(vec![]);
    }
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let v: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    if let Some(scripts) = v.get("scripts").and_then(|s| s.as_object()) {
        for (k, val) in scripts {
            if let Some(cmd) = val.as_str() {
                out.push(PackageScript {
                    name: k.clone(),
                    command: cmd.into(),
                });
            }
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}
