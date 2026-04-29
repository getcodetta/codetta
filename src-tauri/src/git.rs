use serde::Serialize;
use std::path::Path;
use std::process::Command;

fn run_git(cwd: &str, args: &[&str]) -> Result<String, String> {
    let mut cmd = Command::new("git");
    cmd.args(args).current_dir(cwd);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NO_WINDOW = 0x08000000 — don't pop a console for `git`.
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    let stdout = String::from_utf8_lossy(&out.stdout).into_owned();
    let stderr = String::from_utf8_lossy(&out.stderr).into_owned();
    if !out.status.success() {
        let mut msg = stderr.trim().to_string();
        if msg.is_empty() {
            msg = stdout.trim().to_string();
        }
        if msg.is_empty() {
            msg = format!("git {} failed", args.join(" "));
        }
        return Err(msg);
    }
    if stdout.is_empty() && !stderr.is_empty() {
        Ok(stderr)
    } else {
        Ok(stdout)
    }
}

#[derive(Serialize)]
pub struct GitFile {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub staged: bool,
    pub modified: bool,
}

#[derive(Serialize)]
pub struct GitStatus {
    pub is_repo: bool,
    pub branch: Option<String>,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    pub files: Vec<GitFile>,
}

#[tauri::command]
pub fn git_is_repo(path: String) -> bool {
    if !Path::new(&path).exists() {
        return false;
    }
    run_git(&path, &["rev-parse", "--is-inside-work-tree"]).is_ok()
}

fn parse_branch_line(line: &str) -> (Option<String>, Option<String>, u32, u32) {
    // line begins with "## "
    let rest = line.trim_start_matches("## ").to_string();
    if rest.starts_with("HEAD (no branch)") {
        return (Some("HEAD (detached)".to_string()), None, 0, 0);
    }
    if let Some(stripped) = rest.strip_prefix("No commits yet on ") {
        let name = stripped.split_whitespace().next().unwrap_or("").to_string();
        return (Some(name), None, 0, 0);
    }
    let mut upstream: Option<String> = None;
    let mut ahead: u32 = 0;
    let mut behind: u32 = 0;

    let main = rest.split(" [").next().unwrap_or(&rest);
    let branch = if let Some((b, u)) = main.split_once("...") {
        upstream = Some(u.to_string());
        b.to_string()
    } else {
        main.to_string()
    };

    if let Some(start) = rest.find('[') {
        if let Some(end) = rest[start..].find(']') {
            let inside = &rest[start + 1..start + end];
            for part in inside.split(',') {
                let part = part.trim();
                if let Some(n) = part.strip_prefix("ahead ") {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    behind = n.parse().unwrap_or(0);
                }
            }
        }
    }

    (Some(branch), upstream, ahead, behind)
}

#[tauri::command]
pub fn git_status(path: String) -> Result<GitStatus, String> {
    if !git_is_repo(path.clone()) {
        return Ok(GitStatus {
            is_repo: false,
            branch: None,
            upstream: None,
            ahead: 0,
            behind: 0,
            files: vec![],
        });
    }
    let out = run_git(&path, &["status", "--porcelain", "--branch"])?;
    let mut lines = out.lines();
    let branch_line = lines.next().unwrap_or("");
    let (branch, upstream, ahead, behind) = if branch_line.starts_with("## ") {
        parse_branch_line(branch_line)
    } else {
        (None, None, 0, 0)
    };

    let mut files = Vec::new();
    for raw in lines {
        if raw.len() < 3 {
            continue;
        }
        let bytes = raw.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let rest = &raw[3..];
        // Renames look like "R  old -> new"
        let path_part = if let Some(idx) = rest.find(" -> ") {
            rest[idx + 4..].to_string()
        } else {
            rest.to_string()
        };
        let path_part = path_part.trim_matches('"').to_string();
        let staged = x != ' ' && x != '?';
        let modified = y != ' ';
        files.push(GitFile {
            path: path_part,
            index_status: x.to_string(),
            worktree_status: y.to_string(),
            staged,
            modified,
        });
    }

    Ok(GitStatus {
        is_repo: true,
        branch,
        upstream,
        ahead,
        behind,
        files,
    })
}

#[tauri::command]
pub fn git_stage(path: String, files: Vec<String>) -> Result<String, String> {
    if files.is_empty() {
        return Ok(String::new());
    }
    let mut args: Vec<&str> = vec!["add", "--"];
    for f in &files {
        args.push(f.as_str());
    }
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_unstage(path: String, files: Vec<String>) -> Result<String, String> {
    if files.is_empty() {
        return Ok(String::new());
    }
    let mut args: Vec<&str> = vec!["reset", "HEAD", "--"];
    for f in &files {
        args.push(f.as_str());
    }
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_commit(path: String, message: String) -> Result<String, String> {
    run_git(&path, &["commit", "-m", &message])
}

#[tauri::command]
pub fn git_pull(path: String) -> Result<String, String> {
    run_git(&path, &["pull"])
}

#[tauri::command]
pub fn git_push(path: String) -> Result<String, String> {
    run_git(&path, &["push"])
}

#[tauri::command]
pub fn git_fetch(path: String) -> Result<String, String> {
    run_git(&path, &["fetch", "--all", "--prune"])
}

#[tauri::command]
pub fn git_init(path: String) -> Result<String, String> {
    run_git(&path, &["init"])
}

#[tauri::command]
pub fn git_diff(path: String, file: Option<String>) -> Result<String, String> {
    if let Some(f) = file {
        run_git(&path, &["diff", "--", &f])
    } else {
        run_git(&path, &["diff"])
    }
}

#[tauri::command]
pub fn git_diff_staged(path: String, file: Option<String>) -> Result<String, String> {
    if let Some(f) = file {
        run_git(&path, &["diff", "--cached", "--", &f])
    } else {
        run_git(&path, &["diff", "--cached"])
    }
}

#[tauri::command]
pub fn git_show(path: String, refspec: String, file: String) -> Result<String, String> {
    let target = format!("{}:{}", refspec, file);
    match run_git(&path, &["show", &target]) {
        Ok(s) => Ok(s),
        Err(e) => {
            let lower = e.to_lowercase();
            if lower.contains("exists on disk, but not in") || lower.contains("does not exist") {
                Ok(String::new())
            } else {
                Err(e)
            }
        }
    }
}

#[tauri::command]
pub fn git_discard(path: String, files: Vec<String>) -> Result<String, String> {
    if files.is_empty() {
        return Ok(String::new());
    }
    let mut args: Vec<&str> = vec!["checkout", "HEAD", "--"];
    for f in &files {
        args.push(f.as_str());
    }
    run_git(&path, &args)
}

#[tauri::command]
pub fn git_branches(path: String) -> Result<Vec<String>, String> {
    let out = run_git(&path, &["branch", "--format=%(refname:short)"])?;
    Ok(out
        .split('\n')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect())
}

#[tauri::command]
pub fn git_checkout_branch(path: String, branch: String) -> Result<String, String> {
    run_git(&path, &["checkout", &branch])
}
