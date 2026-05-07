use serde::Serialize;
use std::io::Read;
use std::path::{Path, PathBuf};

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

/// Convert a git-style glob pattern to a regex. Same subset as the
/// frontend aiPrivacy globToRegex — `*`, `**`, `?`, `/`, literal text.
/// Used by the include/exclude filter on search_text / search_regex.
fn glob_to_regex(pattern: &str) -> Option<regex::Regex> {
    let p = pattern.trim();
    if p.is_empty() {
        return None;
    }
    let mut re = String::from("^");
    let bytes = p.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        let c = bytes[i] as char;
        if c == '*' && i + 1 < bytes.len() && bytes[i + 1] == b'*' {
            re.push_str(".*");
            i += 2;
            if i < bytes.len() && bytes[i] == b'/' {
                i += 1;
            }
        } else if c == '*' {
            re.push_str("[^/]*");
            i += 1;
        } else if c == '?' {
            re.push_str("[^/]");
            i += 1;
        } else if c == '/' {
            re.push('/');
            i += 1;
        } else if "[]{}().+^$|\\".contains(c) {
            re.push('\\');
            re.push(c);
            i += 1;
        } else {
            re.push(c);
            i += 1;
        }
    }
    re.push('$');
    regex::Regex::new(&re).ok()
}

/// Compile a list of glob patterns to a list of regexes. Drops empty
/// entries + bad patterns silently — the frontend already validates
/// shape; the search loops would rather skip an iffy pattern than die.
fn compile_glob_list(globs: &[String]) -> Vec<regex::Regex> {
    globs
        .iter()
        .filter_map(|g| glob_to_regex(g))
        .collect()
}

/// True when a workspace-relative path should be considered "in scope"
/// given an include and exclude pattern set:
///   - if includes is non-empty, the path must match at least one
///   - the path must NOT match any exclude
fn path_in_scope(rel: &str, includes: &[regex::Regex], excludes: &[regex::Regex]) -> bool {
    if !includes.is_empty() && !includes.iter().any(|re| re.is_match(rel)) {
        return false;
    }
    if excludes.iter().any(|re| re.is_match(rel)) {
        return false;
    }
    true
}

/// Compute a workspace-relative path with forward slashes from an
/// absolute path + workspace root. Returns the original if the path
/// doesn't live under the root (different drive, network share, etc).
fn workspace_rel(root: &str, abs: &str) -> String {
    let r = root.replace('\\', "/").trim_end_matches('/').to_string() + "/";
    let p = abs.replace('\\', "/");
    if p.starts_with(&r) {
        p[r.len()..].to_string()
    } else {
        p
    }
}

fn is_heavy_dir(name: &str) -> bool {
    HEAVY_DIRS.iter().any(|h| h.eq_ignore_ascii_case(name))
}

fn looks_binary(buf: &[u8]) -> bool {
    // Caller passes only the first BINARY_PROBE bytes (read_text_file_capped
    // probes ahead of any decision), so a NUL anywhere in the buffer is
    // treated as a binary indicator.
    buf.contains(&0)
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
    include_globs: Option<Vec<String>>,
    exclude_globs: Option<Vec<String>>,
) -> Result<Vec<SearchHit>, String> {
    if query.is_empty() {
        return Ok(vec![]);
    }
    let cs = case_sensitive.unwrap_or(false);
    let needle = if cs { query.clone() } else { query.to_lowercase() };
    let cap = max_results.unwrap_or(2000);
    let includes = compile_glob_list(&include_globs.unwrap_or_default());
    let excludes = compile_glob_list(&exclude_globs.unwrap_or_default());

    let mut paths: Vec<String> = Vec::new();
    walk_files(Path::new(&root), &mut paths, 50_000, |_p| true);

    let mut hits = Vec::new();
    for p in paths {
        if hits.len() >= cap {
            break;
        }
        let pp = Path::new(&p);
        // Filter by include/exclude on the workspace-relative path so
        // patterns like "src/**/*.ts" or "**/*.test.tsx" behave the way
        // the user wrote them.
        if !includes.is_empty() || !excludes.is_empty() {
            let rel = workspace_rel(&root, &p);
            if !path_in_scope(&rel, &includes, &excludes) {
                continue;
            }
        }
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

/// Same shape as search_text but the query is interpreted as a Rust
/// regex (uses the `regex` crate, ~Perl-compatible without lookahead /
/// backreferences). The case_sensitive flag flips between
/// `Regex::new(pat)` and `RegexBuilder::new(pat).case_insensitive(true)`
/// so the user's UI toggle behaves the same in literal and regex mode.
///
/// Bad patterns return Err with the regex compiler's diagnostic so the
/// frontend can surface "expected ']' at offset 7" instead of dying
/// silently. Empty queries return an empty hit list (same as search_text).
#[tauri::command]
pub fn search_regex(
    root: String,
    pattern: String,
    case_sensitive: Option<bool>,
    max_results: Option<usize>,
    include_globs: Option<Vec<String>>,
    exclude_globs: Option<Vec<String>>,
) -> Result<Vec<SearchHit>, String> {
    if pattern.is_empty() {
        return Ok(vec![]);
    }
    let cs = case_sensitive.unwrap_or(false);
    let cap = max_results.unwrap_or(2000);
    let re = regex::RegexBuilder::new(&pattern)
        .case_insensitive(!cs)
        .build()
        .map_err(|e| format!("Invalid regex: {e}"))?;
    let includes = compile_glob_list(&include_globs.unwrap_or_default());
    let excludes = compile_glob_list(&exclude_globs.unwrap_or_default());

    let mut paths: Vec<String> = Vec::new();
    walk_files(Path::new(&root), &mut paths, 50_000, |_p| true);

    let mut hits = Vec::new();
    for p in paths {
        if hits.len() >= cap {
            break;
        }
        let pp = Path::new(&p);
        if !includes.is_empty() || !excludes.is_empty() {
            let rel = workspace_rel(&root, &p);
            if !path_in_scope(&rel, &includes, &excludes) {
                continue;
            }
        }
        let bytes = match read_text_file_capped(pp, MAX_FILE_BYTES_FOR_SEARCH) {
            Some(b) => b,
            None => continue,
        };
        let text = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => continue,
        };
        for (i, line) in text.lines().enumerate() {
            if let Some(m) = re.find(line) {
                hits.push(SearchHit {
                    path: p.clone(),
                    line: i + 1,
                    // Convert byte offset to a 1-based column count of
                    // chars. Most editors show columns in characters,
                    // not bytes, and this is close enough for ASCII +
                    // most BMP files.
                    col: line[..m.start()].chars().count() + 1,
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

// ---------- Symbol scan (Go to symbol palette mode) ----------

#[derive(Serialize)]
pub struct SymbolHit {
    pub path: String,
    pub line: usize,
    /// "function" / "class" / "interface" / "type" / "enum" / "struct"
    /// / "trait" / "impl" / "const" / "var". The frontend uses this
    /// to render a per-row category badge so users can scan visually.
    pub kind: String,
    pub name: String,
}

fn extract_symbols(path: &str, text: &str, out: &mut Vec<SymbolHit>, cap: usize) {
    // Tiny per-language regex set. We compile lazily inside the file
    // walker — these don't get cached cross-call because the per-file
    // overhead is dwarfed by the file read itself, but we DO cache
    // within a single scan via the closure capture.
    use regex::Regex;
    let lower = path.to_ascii_lowercase();
    let is_ts_js = matches!(
        lower.rsplit('.').next().unwrap_or(""),
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs"
    );
    let is_rust = lower.ends_with(".rs");
    let is_python = lower.ends_with(".py") || lower.ends_with(".pyi");
    let is_go = lower.ends_with(".go");

    // Patterns are anchored at line start (after any whitespace) so
    // we don't match `// fn foo()` style comments. Matching only the
    // first capture group keeps the symbol name clean.
    let patterns: &[(&str, Regex)] = if is_ts_js {
        &[
            ("function", Regex::new(r"^\s*(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+(\w+)").unwrap()),
            ("class", Regex::new(r"^\s*(?:export\s+(?:default\s+)?)?(?:abstract\s+)?class\s+(\w+)").unwrap()),
            ("interface", Regex::new(r"^\s*(?:export\s+)?interface\s+(\w+)").unwrap()),
            ("type", Regex::new(r"^\s*(?:export\s+)?type\s+(\w+)\s*=").unwrap()),
            ("enum", Regex::new(r"^\s*(?:export\s+(?:const\s+)?)?enum\s+(\w+)").unwrap()),
            ("const", Regex::new(r"^\s*(?:export\s+)?(?:const|let|var)\s+(\w+)\s*[:=]").unwrap()),
        ][..]
    } else if is_rust {
        &[
            ("fn", Regex::new(r"^\s*(?:pub(?:\([^)]+\))?\s+)?(?:async\s+)?(?:unsafe\s+)?(?:const\s+)?fn\s+(\w+)").unwrap()),
            ("struct", Regex::new(r"^\s*(?:pub(?:\([^)]+\))?\s+)?struct\s+(\w+)").unwrap()),
            ("enum", Regex::new(r"^\s*(?:pub(?:\([^)]+\))?\s+)?enum\s+(\w+)").unwrap()),
            ("trait", Regex::new(r"^\s*(?:pub(?:\([^)]+\))?\s+)?(?:unsafe\s+)?trait\s+(\w+)").unwrap()),
            ("impl", Regex::new(r"^\s*impl(?:<[^>]+>)?\s+(?:[^{]*?\s+for\s+)?(\w+)").unwrap()),
            ("const", Regex::new(r"^\s*(?:pub(?:\([^)]+\))?\s+)?(?:const|static)\s+(\w+)\s*:").unwrap()),
            ("type", Regex::new(r"^\s*(?:pub(?:\([^)]+\))?\s+)?type\s+(\w+)\s*=").unwrap()),
        ][..]
    } else if is_python {
        &[
            ("def", Regex::new(r"^\s*(?:async\s+)?def\s+(\w+)").unwrap()),
            ("class", Regex::new(r"^\s*class\s+(\w+)").unwrap()),
        ][..]
    } else if is_go {
        &[
            ("func", Regex::new(r"^\s*func\s+(?:\([^)]+\)\s+)?(\w+)").unwrap()),
            ("type", Regex::new(r"^\s*type\s+(\w+)").unwrap()),
            ("var", Regex::new(r"^\s*(?:var|const)\s+(\w+)").unwrap()),
        ][..]
    } else {
        return;
    };

    for (i, line) in text.lines().enumerate() {
        for (kind, re) in patterns {
            if let Some(caps) = re.captures(line) {
                if let Some(name) = caps.get(1) {
                    out.push(SymbolHit {
                        path: path.to_string(),
                        line: i + 1,
                        kind: (*kind).to_string(),
                        name: name.as_str().to_string(),
                    });
                    if out.len() >= cap {
                        return;
                    }
                    // First-match-wins per line so we don't double-count
                    // e.g. "export const Foo: Bar = …" against multiple
                    // patterns.
                    break;
                }
            }
        }
    }
}

const MAX_SYMBOL_FILE_BYTES: u64 = 1024 * 1024;

fn find_symbols_blocking(root: String, cap: usize) -> Vec<SymbolHit> {
    let mut paths: Vec<String> = Vec::new();
    walk_files(Path::new(&root), &mut paths, 50_000, |p| {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let lower = name.to_ascii_lowercase();
        // Only the four languages the symbol extractor knows about.
        // Lockfiles / test fixtures are covered by HEAVY_DIRS.
        lower.ends_with(".ts")
            || lower.ends_with(".tsx")
            || lower.ends_with(".js")
            || lower.ends_with(".jsx")
            || lower.ends_with(".mjs")
            || lower.ends_with(".cjs")
            || lower.ends_with(".rs")
            || lower.ends_with(".py")
            || lower.ends_with(".pyi")
            || lower.ends_with(".go")
    });

    let mut hits: Vec<SymbolHit> = Vec::with_capacity(cap.min(1024));
    for p in paths {
        if hits.len() >= cap {
            break;
        }
        let pp = Path::new(&p);
        let bytes = match read_text_file_capped(pp, MAX_SYMBOL_FILE_BYTES) {
            Some(b) => b,
            None => continue,
        };
        let text = match std::str::from_utf8(&bytes) {
            Ok(s) => s,
            Err(_) => continue,
        };
        extract_symbols(&p, text, &mut hits, cap);
    }
    hits
}

#[tauri::command]
pub async fn find_symbols(
    root: String,
    max_results: Option<usize>,
) -> Result<Vec<SymbolHit>, String> {
    let cap = max_results.unwrap_or(3000);
    tauri::async_runtime::spawn_blocking(move || find_symbols_blocking(root, cap))
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

// Resolve where the project's Cargo manifest lives. Tauri apps bury it
// one level down (src-tauri/Cargo.toml); pure-Rust projects keep it at
// the workspace root. We try root/Cargo.toml first, then src-tauri,
// then a couple of other common conventions.
fn find_cargo_manifest(root: &Path) -> Option<PathBuf> {
    let candidates = ["Cargo.toml", "src-tauri/Cargo.toml", "rust/Cargo.toml"];
    for rel in candidates {
        let p = root.join(rel);
        if p.exists() {
            return Some(p);
        }
    }
    None
}

// Pull out names from Cargo.toml's `[[bin]]` and `[[example]]` array
// tables. We don't ship a real TOML parser — Cargo.toml's grammar is
// constrained enough that walking line-by-line catches the cases we
// care about (single-binary crate, multi-binary crate, examples
// folder). Anything fancier (cfg-gated bins, build.rs workarounds)
// falls back to the plain `cargo run` task and isn't a regression.
fn collect_cargo_targets(manifest_text: &str, table_name: &str) -> Vec<String> {
    let header = format!("[[{}]]", table_name);
    let mut out = Vec::new();
    let mut in_table = false;
    for raw in manifest_text.lines() {
        let line = raw.trim();
        // A bracketed header always switches tables. We only consider
        // ourselves "inside" the target table immediately after seeing
        // [[bin]] or [[example]]; any other [...] header takes us out.
        if line.starts_with('[') && line.ends_with(']') {
            in_table = line == header;
            continue;
        }
        if !in_table {
            continue;
        }
        // We only care about the `name = "..."` key; everything else
        // (path, required-features, edition, doc-comments) is noise.
        let stripped = line.split('#').next().unwrap_or(line).trim();
        if let Some(rest) = stripped.strip_prefix("name") {
            let rest = rest.trim_start();
            if let Some(rest) = rest.strip_prefix('=') {
                let val = rest.trim().trim_matches(|c| c == '"' || c == '\'');
                if !val.is_empty() {
                    out.push(val.to_string());
                }
            }
        }
    }
    out
}

// Discover convention-based binaries — files matching `src/bin/*.rs`
// and subdirectories with their own `main.rs` (`src/bin/foo/main.rs`).
// Cargo treats both as binaries even when they aren't listed in
// Cargo.toml, so the editor task panel should too.
fn collect_convention_bins(manifest_dir: &Path) -> Vec<String> {
    let bin_dir = manifest_dir.join("src").join("bin");
    let mut out = Vec::new();
    let Ok(entries) = std::fs::read_dir(&bin_dir) else {
        return out;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else { continue };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if ft.is_file() {
            if let Some(stem) = name.strip_suffix(".rs") {
                if !stem.is_empty() {
                    out.push(stem.to_string());
                }
            }
        } else if ft.is_dir() && entry.path().join("main.rs").exists() {
            out.push(name.to_string());
        }
    }
    out
}

// Detect whether the manifest is a workspace root with no [package]
// of its own. `cargo run` against a virtual workspace fails — we
// shouldn't surface "cargo run" without a target hint when that's the
// case. Heuristic: contains a `[workspace]` table and either no
// `[package]` or [package] sits under `[workspace.package]` only.
fn is_virtual_workspace(manifest_text: &str) -> bool {
    let mut has_workspace = false;
    let mut has_package = false;
    for raw in manifest_text.lines() {
        let line = raw.trim();
        if line == "[workspace]" {
            has_workspace = true;
        } else if line == "[package]" {
            has_package = true;
        }
    }
    has_workspace && !has_package
}

#[tauri::command]
pub fn read_cargo_tasks(root: String) -> Result<Vec<PackageScript>, String> {
    let manifest = match find_cargo_manifest(Path::new(&root)) {
        Some(p) => p,
        None => return Ok(vec![]),
    };
    let manifest_dir = manifest
        .parent()
        .map(|p| p.to_path_buf())
        .unwrap_or_else(|| Path::new(&root).to_path_buf());
    // If the manifest sits in a subdirectory (the Tauri case), every
    // command needs `--manifest-path` so users running tasks from any
    // workspace root land in the right crate.
    let needs_manifest_path = manifest_dir != Path::new(&root);
    let manifest_arg = if needs_manifest_path {
        let rel = manifest_dir
            .strip_prefix(Path::new(&root))
            .unwrap_or(&manifest_dir)
            .to_string_lossy()
            .replace('\\', "/");
        format!(" --manifest-path {}/Cargo.toml", rel)
    } else {
        String::new()
    };
    let manifest_text = std::fs::read_to_string(&manifest).unwrap_or_default();
    let virt = is_virtual_workspace(&manifest_text);

    let mut out: Vec<PackageScript> = Vec::new();
    // Standard verbs. For virtual workspaces, `cargo run` is undefined
    // without a --bin hint — drop the bare "cargo run" entry and let
    // the per-bin entries below cover it.
    let standard_tasks: &[(&str, &str)] = if virt {
        &[
            ("build", "Compile every crate in the workspace"),
            ("test", "Run tests across the workspace"),
            ("check", "Type-check the workspace"),
            ("clippy", "Run the linter across the workspace"),
            ("fmt", "Format the workspace"),
        ]
    } else {
        &[
            ("build", "Compile the project"),
            ("run", "Build and run"),
            ("test", "Run tests"),
            ("check", "Type-check without producing artifacts"),
            ("clippy", "Run the linter"),
            ("fmt", "Format the source tree"),
        ]
    };
    for (name, desc) in standard_tasks {
        out.push(PackageScript {
            name: format!("cargo {}", name),
            command: format!("cargo {}{}  # {}", name, manifest_arg, desc),
        });
    }
    // Per-binary `cargo run --bin <name>` entries — surfaced in the
    // panel so the user doesn't need to remember every binary name in
    // a multi-bin crate. Sourced from both [[bin]] entries and the
    // src/bin/ convention; deduplicated to handle crates that declare
    // both.
    let mut bins: Vec<String> = collect_cargo_targets(&manifest_text, "bin");
    for b in collect_convention_bins(&manifest_dir) {
        if !bins.contains(&b) {
            bins.push(b);
        }
    }
    bins.sort();
    bins.dedup();
    for bin in &bins {
        out.push(PackageScript {
            name: format!("cargo run --bin {}", bin),
            command: format!("cargo run --bin {}{}", bin, manifest_arg),
        });
    }
    // Per-example `cargo run --example <name>` entries — same pattern.
    // We only include those declared in [[example]]; a future pass
    // could also walk examples/*.rs but the convention is less
    // universally followed than src/bin/.
    let examples = collect_cargo_targets(&manifest_text, "example");
    let mut examples: Vec<String> = examples;
    examples.sort();
    examples.dedup();
    for ex in &examples {
        out.push(PackageScript {
            name: format!("cargo run --example {}", ex),
            command: format!("cargo run --example {}{}", ex, manifest_arg),
        });
    }
    Ok(out)
}

#[tauri::command]
pub fn read_makefile_targets(root: String) -> Result<Vec<PackageScript>, String> {
    // Order matters: GNU make resolves these the same way, and we match
    // its precedence so users see whichever Makefile actually runs.
    let candidates = ["GNUmakefile", "makefile", "Makefile"];
    let mut path: Option<PathBuf> = None;
    for c in candidates {
        let p = Path::new(&root).join(c);
        if p.exists() {
            path = Some(p);
            break;
        }
    }
    let Some(path) = path else {
        return Ok(vec![]);
    };
    let text = std::fs::read_to_string(&path).map_err(|e| e.to_string())?;
    // Parse target lines: anything matching `^[A-Za-z0-9_.-]+\s*:` that
    // isn't a variable assignment (`:=`) and isn't a special pseudo
    // target (`.PHONY`, `.SUFFIXES`, etc.). We strip dependencies after
    // the colon and surface only the target name. Recipe lines (tab-
    // indented) get skipped because the regex requires the line to
    // start at column 0.
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    for line in text.lines() {
        // Skip indented lines (recipe bodies) and comments.
        if line.starts_with('\t') || line.starts_with('#') {
            continue;
        }
        let trimmed = line.trim_end();
        let Some(colon_idx) = trimmed.find(':') else {
            continue;
        };
        // `:=` and `::=` are variable assignments, not target rules.
        let after = &trimmed[colon_idx..];
        if after.starts_with(":=") || after.starts_with("::=") {
            continue;
        }
        let name = trimmed[..colon_idx].trim();
        if name.is_empty() {
            continue;
        }
        // Skip pattern rules (% in name) and pseudo targets — neither
        // is the kind of thing a user wants to "run from the panel."
        if name.starts_with('.') || name.contains('%') || name.contains(' ') {
            continue;
        }
        if !name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-' || c == '.' || c == '/')
        {
            continue;
        }
        if !seen.insert(name.to_string()) {
            continue;
        }
        out.push(PackageScript {
            name: name.to_string(),
            command: format!("make {}", name),
        });
    }
    Ok(out)
}
