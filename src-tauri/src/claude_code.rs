use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Default)]
pub struct ClaudeCodeState {
    children: Mutex<HashMap<String, Arc<Mutex<Child>>>>,
}

/// Quick availability check — returns the version string or an error.
/// Tries multiple variants because npm-installed CLIs on Windows are `.cmd`
/// shims (which `Command::new("claude")` won't find without going through a
/// shell), and some users keep claude in `~/.claude/local`.
#[tauri::command]
pub fn claude_code_check() -> Result<String, String> {
    // Variant 1: direct invocation.
    if let Ok(v) = try_run_claude(&["--version"], None) {
        return Ok(v);
    }
    // Variant 2: shell-mediated — picks up .cmd shims and shell PATH
    // additions (nvm, asdf, etc.) that the spawning subprocess doesn't see.
    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", "claude --version"]);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
            }
        }
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("sh");
        cmd.args(["-lc", "claude --version"]);
        if let Ok(out) = cmd.output() {
            if out.status.success() {
                return Ok(String::from_utf8_lossy(&out.stdout).trim().to_string());
            }
        }
    }
    // Variant 3: common per-user install locations.
    if let Some(home) = dirs::home_dir() {
        let candidates: &[&str] = if cfg!(windows) {
            &["AppData/Roaming/npm/claude.cmd", ".claude/local/claude.cmd"]
        } else {
            &[".claude/local/claude", ".local/bin/claude"]
        };
        for rel in candidates {
            let path = home.join(rel);
            if path.exists() {
                if let Ok(v) = try_run_claude(&["--version"], Some(&path.to_string_lossy())) {
                    return Ok(v);
                }
            }
        }
    }
    Err("claude CLI not found on PATH or common install locations".to_string())
}

/// Build a Command that will invoke claude WITHOUT passing the prompt as an
/// argument — the prompt is piped via stdin instead, which sidesteps the
/// Windows ~8191-char command-line limit (otherwise blown by inlined file
/// trees / large message histories). Picks the best resolution strategy:
/// direct binary if reachable, otherwise shell-mediated so .cmd shims and
/// custom PATH entries (nvm, asdf, etc.) resolve correctly.
fn build_claude_command(
    _prompt: &str,
    model: Option<&str>,
    resume: Option<&str>,
    cwd: Option<&str>,
) -> Command {
    // Test direct invocation availability quickly.
    let direct_works = {
        let mut probe = Command::new("claude");
        probe.arg("--version");
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            probe.creation_flags(0x08000000);
        }
        probe.output().map(|o| o.status.success()).unwrap_or(false)
    };

    // "default" sentinel = don't pass --model, let Claude Code use its
    // own configured default (whatever `claude /login` set up).
    let model_to_pass = match model {
        Some("default") | Some("") => None,
        other => other,
    };

    if direct_works {
        let mut cmd = Command::new("claude");
        // Use -p with no prompt argument — claude reads from stdin.
        cmd.arg("-p");
        cmd.arg("--output-format").arg("stream-json");
        cmd.arg("--verbose");
        // In headless print mode, tool permissions block non-interactive
        // tool use; without this flag the agent loop ends after the
        // model's first text turn ("I'll explore the codebase…") because
        // it can't actually invoke Read/Edit/Bash. This flag is what the
        // Claude Code SDK / scripted users pass for the same reason.
        cmd.arg("--dangerously-skip-permissions");
        if let Some(m) = model_to_pass {
            cmd.arg("--model").arg(m);
        }
        if let Some(s) = resume {
            cmd.arg("--resume").arg(s);
        }
        if let Some(d) = cwd {
            cmd.current_dir(d);
        }
        return cmd;
    }

    // Fall back to shell-mediated invocation — also stdin-driven.
    let mut shell_cmd = String::from(
        "claude -p --output-format stream-json --verbose --dangerously-skip-permissions",
    );
    if let Some(m) = model_to_pass {
        shell_cmd.push_str(" --model ");
        shell_cmd.push_str(&shell_quote(m));
    }
    if let Some(s) = resume {
        shell_cmd.push_str(" --resume ");
        shell_cmd.push_str(&shell_quote(s));
    }

    #[cfg(windows)]
    {
        let mut cmd = Command::new("cmd");
        cmd.args(["/c", &shell_cmd]);
        if let Some(d) = cwd {
            cmd.current_dir(d);
        }
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("sh");
        cmd.args(["-lc", &shell_cmd]);
        if let Some(d) = cwd {
            cmd.current_dir(d);
        }
        cmd
    }
}

fn shell_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            _ => out.push(c),
        }
    }
    out.push('"');
    out
}

fn try_run_claude(args: &[&str], explicit_path: Option<&str>) -> Result<String, String> {
    let mut cmd = Command::new(explicit_path.unwrap_or("claude"));
    cmd.args(args);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000);
    }
    let out = cmd.output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(format!(
            "claude failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).trim().to_string())
}

/// Spawn `claude -p <prompt>` with stream-json output. Each output line is
/// emitted on the event `claude-stream:<id>` as `{ kind: "line", line: "<json>" }`,
/// and an end event `claude-stream:<id>` with `{ kind: "end", code: <i32> }`
/// fires when the process exits. Returns the stream id.
#[tauri::command]
pub fn claude_code_chat(
    app: AppHandle,
    state: State<'_, ClaudeCodeState>,
    prompt: String,
    cwd: Option<String>,
    model: Option<String>,
    resume_session_id: Option<String>,
) -> Result<String, String> {
    let id = Uuid::new_v4().to_string();
    let event_name = format!("claude-stream:{}", id);

    let mut cmd = build_claude_command(
        &prompt,
        model.as_deref(),
        resume_session_id.as_deref(),
        cwd.as_deref(),
    );
    cmd.stdin(Stdio::piped());
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
    }

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to spawn claude: {}", e))?;

    // Write the prompt to stdin and close it, so claude knows the input
    // is complete. Doing this in a thread to avoid blocking on a large
    // prompt vs. the OS pipe buffer.
    if let Some(mut stdin) = child.stdin.take() {
        let prompt_bytes = prompt.into_bytes();
        thread::spawn(move || {
            let _ = stdin.write_all(&prompt_bytes);
            // Drop stdin closes the pipe → EOF for claude.
        });
    }

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "no stdout from claude".to_string())?;
    let stderr = child.stderr.take();

    let child_arc = Arc::new(Mutex::new(child));
    state
        .children
        .lock()
        .insert(id.clone(), Arc::clone(&child_arc));

    // Reader thread for stdout — emit each line as a stream event.
    let app_for_stdout = app.clone();
    let event_for_stdout = event_name.clone();
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            match line {
                Ok(l) => {
                    let _ = app_for_stdout.emit(
                        &event_for_stdout,
                        serde_json::json!({ "kind": "line", "line": l }),
                    );
                }
                Err(_) => break,
            }
        }
    });

    // Reader thread for stderr — surface errors as a separate event channel
    // so the frontend can show them in the chat result.
    if let Some(stderr) = stderr {
        let app_for_stderr = app.clone();
        let event_for_stderr = event_name.clone();
        thread::spawn(move || {
            let reader = BufReader::new(stderr);
            for line in reader.lines() {
                if let Ok(l) = line {
                    let _ = app_for_stderr.emit(
                        &event_for_stderr,
                        serde_json::json!({ "kind": "stderr", "line": l }),
                    );
                }
            }
        });
    }

    // Waiter thread — emit `end` once the process exits.
    let app_for_wait = app.clone();
    let event_for_wait = event_name.clone();
    let child_for_wait = Arc::clone(&child_arc);
    let id_for_wait = id.clone();
    thread::spawn(move || {
        let exit_code = match child_for_wait.lock().wait() {
            Ok(s) => s.code().unwrap_or(-1),
            Err(_) => -1,
        };
        let _ = app_for_wait.emit(
            &event_for_wait,
            serde_json::json!({ "kind": "end", "code": exit_code }),
        );
        // Drop the child reference from state (best-effort).
        // We can't access State directly from a thread; do it via app state.
        if let Some(state) = app_for_wait.try_state::<ClaudeCodeState>() {
            state.children.lock().remove(&id_for_wait);
        }
    });

    Ok(id)
}

/// Kill an in-flight claude process by stream id.
#[tauri::command]
pub fn claude_code_kill(state: State<'_, ClaudeCodeState>, id: String) -> Result<(), String> {
    let child = state.children.lock().remove(&id);
    if let Some(child) = child {
        let mut guard = child.lock();
        let _ = guard.kill();
    }
    Ok(())
}
