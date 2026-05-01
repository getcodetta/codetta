use parking_lot::Mutex;
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI64, Ordering};
use std::sync::Arc;
use std::thread;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

/// If the claude subprocess emits nothing for this long after producing
/// at least one event, we assume it's hung (the documented
/// anthropics/claude-code#1920 class of bug — terminal `result` event
/// never arrives) and force a clean shutdown so the frontend doesn't
/// spin forever waiting for `end`.
const IDLE_TIMEOUT: Duration = Duration::from_secs(120);

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

/// Tools that genuinely change state and warrant a confirm-card. We
/// deliberately exclude Read / Glob / Grep / WebFetch / WebSearch /
/// TodoWrite — those don't touch user files or run external programs,
/// so prompting on every one of them is just noise.
const PERMISSION_GATED_TOOLS: &str = "Bash|Edit|MultiEdit|Write|NotebookEdit";

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
    use_hooks: bool,
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
        // Permission strategy:
        //   - use_hooks=true: PreToolUse hook in .claude/settings.local.json
        //     calls our localhost server, which surfaces a permission
        //     card in the GUI. We use --permission-mode default so the
        //     hook actually fires (bypass mode short-circuits hooks).
        //   - use_hooks=false: legacy fallback for when the perm server
        //     didn't come up. Skip prompts entirely so the agent loop
        //     can run; user accepts the same blast radius as before.
        if use_hooks {
            cmd.arg("--permission-mode").arg("default");
        } else {
            cmd.arg("--dangerously-skip-permissions");
        }
        if let Some(m) = model_to_pass {
            cmd.arg("--model").arg(m);
        }
        if let Some(s) = resume {
            cmd.arg("--resume").arg(s);
        }
        if let Some(d) = cwd {
            cmd.current_dir(d);
        }
        apply_clean_env(&mut cmd);
        return cmd;
    }

    // Fall back to shell-mediated invocation — also stdin-driven.
    let perm_flag = if use_hooks {
        "--permission-mode default"
    } else {
        "--dangerously-skip-permissions"
    };
    let mut shell_cmd = format!(
        "claude -p --output-format stream-json --verbose {}",
        perm_flag
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
        apply_clean_env(&mut cmd);
        cmd
    }
    #[cfg(not(windows))]
    {
        let mut cmd = Command::new("sh");
        cmd.args(["-lc", &shell_cmd]);
        if let Some(d) = cwd {
            cmd.current_dir(d);
        }
        apply_clean_env(&mut cmd);
        cmd
    }
}

/// Ensure `<workspace>/.claude/settings.local.json` contains a
/// PreToolUse hook that POSTs to our localhost permission endpoint
/// for the destructive-tool matcher. Idempotent — preserves any
/// other hooks the user may have configured, and dedupes our own
/// entry by command string.
fn ensure_pretooluse_hook(workspace: &str, endpoint: &str) -> Result<(), String> {
    use std::fs;
    use std::path::Path;

    let claude_dir = Path::new(workspace).join(".claude");
    fs::create_dir_all(&claude_dir).map_err(|e| e.to_string())?;
    let settings_path = claude_dir.join("settings.local.json");

    // Load existing settings if present, else start fresh. Tolerate
    // malformed JSON by overwriting — claude itself can't read it
    // either, so the user has nothing to lose.
    let mut root: serde_json::Value = if settings_path.exists() {
        let s = fs::read_to_string(&settings_path).unwrap_or_default();
        serde_json::from_str(&s).unwrap_or_else(|_| serde_json::json!({}))
    } else {
        serde_json::json!({})
    };
    if !root.is_object() {
        root = serde_json::json!({});
    }

    let hook_command = build_hook_command(endpoint);
    let our_entry = serde_json::json!({
        "matcher": PERMISSION_GATED_TOOLS,
        "hooks": [
            {
                "type": "command",
                "command": hook_command,
                // Codetta-managed marker so we can update / dedupe
                // ourselves without touching user-authored entries.
                "_codetta": true,
            }
        ]
    });

    // Drill into root.hooks.PreToolUse, creating intermediates as needed.
    let hooks_obj = root
        .as_object_mut()
        .unwrap()
        .entry("hooks".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !hooks_obj.is_object() {
        *hooks_obj = serde_json::json!({});
    }
    let pretooluse = hooks_obj
        .as_object_mut()
        .unwrap()
        .entry("PreToolUse".to_string())
        .or_insert_with(|| serde_json::json!([]));
    if !pretooluse.is_array() {
        *pretooluse = serde_json::json!([]);
    }
    let arr = pretooluse.as_array_mut().unwrap();

    // Dedupe: drop any prior Codetta-managed entry, then push fresh.
    arr.retain(|entry| {
        let inner = entry.get("hooks").and_then(|h| h.as_array());
        let is_ours = inner
            .map(|hs| {
                hs.iter()
                    .any(|h| h.get("_codetta").and_then(|v| v.as_bool()).unwrap_or(false))
            })
            .unwrap_or(false);
        !is_ours
    });
    arr.push(our_entry);

    let pretty = serde_json::to_string_pretty(&root).map_err(|e| e.to_string())?;
    fs::write(&settings_path, pretty).map_err(|e| e.to_string())?;
    Ok(())
}

/// Build the shell command that the PreToolUse hook runs. Uses Node
/// (which Claude Code requires anyway, so it's guaranteed available)
/// to read the JSON payload from stdin, POST it to our endpoint, read
/// back the decision body, and exit with that code.
fn build_hook_command(endpoint: &str) -> String {
    // Node one-liner. Single-quoted in JSON to keep escapes manageable.
    // Logic: pipe stdin → POST endpoint → exit with response body as int.
    let js = format!(
        r#"const http=require('http');let b='';process.stdin.on('data',c=>b+=c).on('end',()=>{{const u=new URL('{endpoint}');const r=http.request({{hostname:u.hostname,port:u.port,path:u.pathname,method:'POST',headers:{{'content-length':Buffer.byteLength(b)}}}},res=>{{let d='';res.on('data',c=>d+=c).on('end',()=>process.exit(parseInt(String(d).trim(),10)||0))}});r.on('error',()=>process.exit(0));r.write(b);r.end()}});"#,
        endpoint = endpoint
    );
    format!("node -e \"{}\"", js.replace('"', "\\\""))
}

/// Disable color / TTY-style output from the claude subprocess so ANSI
/// escapes can't leak into the JSON stream and corrupt our parser. Also
/// suppress the npm-style update check so it doesn't add a noisy
/// pre-output banner that might hit stdout before the first stream-json
/// event.
fn apply_clean_env(cmd: &mut Command) {
    cmd.env("NO_COLOR", "1");
    cmd.env("CLICOLOR", "0");
    cmd.env("FORCE_COLOR", "0");
    cmd.env("TERM", "dumb");
    // Some CLIs auto-detect interactive output; explicitly opt out.
    cmd.env("CI", "1");
    // Avoid claude-cli's auto-update banner stealing the first stdout
    // line (which would break our JSON parser).
    cmd.env("CLAUDE_SKIP_UPDATE_CHECK", "1");
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

    // Install / refresh the PreToolUse hook in this workspace so
    // destructive tool calls hit our permission card. If the perm
    // server didn't come up (port collision etc.) fall back to
    // dangerously-skip-permissions so the agent still works.
    let perm_endpoint = app
        .try_state::<crate::claude_perm::PermState>()
        .and_then(|s| {
            let port = *s.port.lock();
            port.map(|p| format!("http://127.0.0.1:{}/permission", p))
        });
    let use_hooks = if let (Some(endpoint), Some(workspace_cwd)) =
        (perm_endpoint.as_ref(), cwd.as_deref())
    {
        match ensure_pretooluse_hook(workspace_cwd, endpoint) {
            Ok(_) => true,
            Err(e) => {
                eprintln!("[claude_code] hook install failed: {} — falling back", e);
                false
            }
        }
    } else {
        false
    };

    let mut cmd = build_claude_command(
        &prompt,
        model.as_deref(),
        resume_session_id.as_deref(),
        cwd.as_deref(),
        use_hooks,
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

    // Tracks the wall-clock instant of the most recent stdout/stderr
    // event so the watchdog thread can detect a hung subprocess. Stored
    // as i64 millis since the spawn instant — atomic for cross-thread
    // updates without a lock.
    let started = Instant::now();
    let last_activity = Arc::new(AtomicI64::new(0));

    // Reader thread for stdout — emit each line as a stream event.
    // Uses read_line directly instead of `.lines()` so a single huge
    // tool_result (Read on a large file, Bash with verbose stdout)
    // can't blow up against the default Lines iterator buffer cap.
    let app_for_stdout = app.clone();
    let event_for_stdout = event_name.clone();
    let last_activity_stdout = Arc::clone(&last_activity);
    thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut buf = String::with_capacity(8 * 1024);
        loop {
            buf.clear();
            match reader.read_line(&mut buf) {
                Ok(0) => break, // EOF
                Ok(_) => {
                    // Trim the trailing newline but keep the rest verbatim
                    // (a tool_result line can be arbitrarily long).
                    let line = buf.trim_end_matches(&['\n', '\r'][..]).to_string();
                    if line.is_empty() {
                        continue;
                    }
                    last_activity_stdout
                        .store(started.elapsed().as_millis() as i64, Ordering::Relaxed);
                    let _ = app_for_stdout.emit(
                        &event_for_stdout,
                        serde_json::json!({ "kind": "line", "line": line }),
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
        let last_activity_stderr = Arc::clone(&last_activity);
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buf = String::with_capacity(2 * 1024);
            loop {
                buf.clear();
                match reader.read_line(&mut buf) {
                    Ok(0) => break,
                    Ok(_) => {
                        let line = buf.trim_end_matches(&['\n', '\r'][..]).to_string();
                        if line.is_empty() {
                            continue;
                        }
                        last_activity_stderr
                            .store(started.elapsed().as_millis() as i64, Ordering::Relaxed);
                        let _ = app_for_stderr.emit(
                            &event_for_stderr,
                            serde_json::json!({ "kind": "stderr", "line": line }),
                        );
                    }
                    Err(_) => break,
                }
            }
        });
    }

    // Watchdog: if no stdout/stderr activity for IDLE_TIMEOUT after the
    // first event, kill the child and synthesize an error so the
    // frontend doesn't hang forever (anthropics/claude-code#1920).
    let app_for_watchdog = app.clone();
    let event_for_watchdog = event_name.clone();
    let child_for_watchdog = Arc::clone(&child_arc);
    let last_activity_watchdog = Arc::clone(&last_activity);
    thread::spawn(move || {
        loop {
            thread::sleep(Duration::from_secs(5));
            // Poll: is the child still alive?
            let still_running = match child_for_watchdog.lock().try_wait() {
                Ok(None) => true,
                _ => false,
            };
            if !still_running {
                return;
            }
            let last = last_activity_watchdog.load(Ordering::Relaxed);
            // No activity yet (haven't even started streaming) — skip.
            if last == 0 {
                continue;
            }
            let now = started.elapsed().as_millis() as i64;
            if now - last > IDLE_TIMEOUT.as_millis() as i64 {
                // Hung. Force-kill and let the wait thread emit `end`.
                let _ = app_for_watchdog.emit(
                    &event_for_watchdog,
                    serde_json::json!({
                        "kind": "stderr",
                        "line": format!(
                            "[claude] no events for {}s — force-closing the stream (this is the documented anthropics/claude-code#1920 hang).",
                            IDLE_TIMEOUT.as_secs()
                        ),
                    }),
                );
                let _ = child_for_watchdog.lock().kill();
                return;
            }
        }
    });

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

#[derive(serde::Serialize, Clone)]
pub struct ClaudeSession {
    /// Session UUID — pass to `--resume` to continue this conversation.
    pub id: String,
    /// First user message of the session, trimmed to ~80 chars. Used as
    /// the picker entry's title.
    pub title: String,
    /// Last user message preview, trimmed to ~140 chars. Helps the user
    /// remember which session is which when titles look similar.
    pub preview: String,
    /// Total USD cost summed across all result events. May be 0 for
    /// subscription-only sessions where cost wasn't reported.
    pub cost_usd: f64,
    /// Number of user turns (i.e. distinct user messages) in the file.
    pub turn_count: usize,
    /// Unix epoch millis of the last modification to the JSONL file.
    pub last_turn_at_ms: u64,
}

/// List all Claude Code sessions persisted on disk for the given
/// workspace cwd. Reads `~/.claude/projects/<encoded-cwd>/*.jsonl`
/// and extracts a summary of each. Sorted newest-first.
#[tauri::command]
pub fn claude_code_list_sessions(cwd: String) -> Result<Vec<ClaudeSession>, String> {
    use std::fs;
    use std::time::SystemTime;

    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let encoded = encode_project_path(&cwd);
    let dir = home.join(".claude").join("projects").join(&encoded);
    if !dir.exists() {
        return Ok(Vec::new());
    }
    let mut sessions: Vec<ClaudeSession> = Vec::new();
    for entry in fs::read_dir(&dir).map_err(|e| e.to_string())? {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => continue,
        };
        let path = entry.path();
        let ext = path.extension().and_then(|x| x.to_str()).unwrap_or("");
        if ext != "jsonl" {
            continue;
        }
        let id = path
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("")
            .to_string();
        if id.is_empty() {
            continue;
        }
        // Parse the file line-by-line to avoid loading huge sessions.
        let file = match fs::File::open(&path) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let mut first_user: Option<String> = None;
        let mut last_user: Option<String> = None;
        let mut cost_usd: f64 = 0.0;
        let mut turn_count: usize = 0;
        let reader = BufReader::new(file);
        let mut buf = String::with_capacity(4 * 1024);
        let mut r = reader;
        loop {
            buf.clear();
            match std::io::BufRead::read_line(&mut r, &mut buf) {
                Ok(0) => break,
                Ok(_) => {
                    let line = buf.trim();
                    if line.is_empty() {
                        continue;
                    }
                    let v: serde_json::Value = match serde_json::from_str(line) {
                        Ok(v) => v,
                        Err(_) => continue,
                    };
                    let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
                    if ty == "user" {
                        if let Some(text) = extract_user_text(&v) {
                            // Skip system-generated user messages
                            // (tool_result blocks, etc) — only count
                            // genuine user turns.
                            if !text.trim().is_empty() {
                                if first_user.is_none() {
                                    first_user = Some(text.clone());
                                }
                                last_user = Some(text);
                                turn_count += 1;
                            }
                        }
                    } else if ty == "result" {
                        if let Some(c) = v.get("cost_usd").and_then(|x| x.as_f64()) {
                            cost_usd += c;
                        }
                    }
                }
                Err(_) => break,
            }
        }
        let title = first_user
            .as_deref()
            .map(|s| trim_oneline(s, 80))
            .unwrap_or_else(|| "(empty)".to_string());
        let preview = last_user
            .as_deref()
            .map(|s| trim_oneline(s, 140))
            .unwrap_or_default();
        let last_turn_at_ms = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| {
                t.duration_since(SystemTime::UNIX_EPOCH)
                    .map(|d| d.as_millis() as u64)
                    .unwrap_or(0)
            })
            .unwrap_or(0);
        sessions.push(ClaudeSession {
            id,
            title,
            preview,
            cost_usd,
            turn_count,
            last_turn_at_ms,
        });
    }
    sessions.sort_by(|a, b| b.last_turn_at_ms.cmp(&a.last_turn_at_ms));
    Ok(sessions)
}

/// One reconstructed message from a saved session, in the same shape
/// the frontend's ChatMessage type uses. We emit the standard four
/// roles plus an optional `tool_results` array on assistant messages
/// so the UI can render Read / Edit / Bash output the same way it
/// does for fresh stream-json events.
#[derive(serde::Serialize, Clone)]
pub struct LoadedMessage {
    pub role: String,
    pub content: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_calls: Vec<LoadedToolCall>,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub tool_results: Vec<LoadedToolResult>,
}

#[derive(serde::Serialize, Clone)]
pub struct LoadedToolCall {
    pub id: Option<String>,
    pub function: LoadedToolFunction,
}

#[derive(serde::Serialize, Clone)]
pub struct LoadedToolFunction {
    pub name: String,
    pub arguments: serde_json::Value,
}

#[derive(serde::Serialize, Clone)]
pub struct LoadedToolResult {
    pub tool_use_id: String,
    pub content: String,
    pub is_error: Option<bool>,
}

/// Reconstruct the full message history of a saved Claude Code
/// session from its JSONL file. Coalesces tool_use blocks into the
/// assistant message they belong to, and matches tool_result blocks
/// to that same assistant message via tool_use_id (so the chat UI
/// can render results inline beneath their calls).
#[tauri::command]
pub fn claude_code_load_session(
    cwd: String,
    session_id: String,
) -> Result<Vec<LoadedMessage>, String> {
    use std::fs;

    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    let encoded = encode_project_path(&cwd);
    let path = home
        .join(".claude")
        .join("projects")
        .join(&encoded)
        .join(format!("{}.jsonl", session_id));
    if !path.exists() {
        return Err(format!("session {} not found at {:?}", session_id, path));
    }

    let file = fs::File::open(&path).map_err(|e| e.to_string())?;
    let mut reader = BufReader::new(file);
    let mut buf = String::with_capacity(8 * 1024);

    let mut messages: Vec<LoadedMessage> = Vec::new();

    loop {
        buf.clear();
        match std::io::BufRead::read_line(&mut reader, &mut buf) {
            Ok(0) => break,
            Ok(_) => {
                let line = buf.trim();
                if line.is_empty() {
                    continue;
                }
                let v: serde_json::Value = match serde_json::from_str(line) {
                    Ok(v) => v,
                    Err(_) => continue,
                };
                let ty = v.get("type").and_then(|x| x.as_str()).unwrap_or("");
                match ty {
                    "user" => {
                        // User messages may be a real prompt OR a
                        // tool_result echo. Collect text + any
                        // tool_results, attach the tool_results to
                        // the most recent assistant message.
                        let (text, results) = extract_user_blocks(&v);
                        if !results.is_empty() {
                            // Find the latest assistant message and
                            // append these tool_results to it.
                            if let Some(last_asst) = messages
                                .iter_mut()
                                .rev()
                                .find(|m| m.role == "assistant")
                            {
                                last_asst.tool_results.extend(results);
                            }
                        }
                        if !text.is_empty() {
                            messages.push(LoadedMessage {
                                role: "user".into(),
                                content: text,
                                tool_calls: Vec::new(),
                                tool_results: Vec::new(),
                            });
                        }
                    }
                    "assistant" => {
                        let (text, calls) = extract_assistant_blocks(&v);
                        // Skip empty assistant frames (Claude Code
                        // sometimes emits init-only assistant messages).
                        if text.is_empty() && calls.is_empty() {
                            continue;
                        }
                        messages.push(LoadedMessage {
                            role: "assistant".into(),
                            content: text,
                            tool_calls: calls,
                            tool_results: Vec::new(),
                        });
                    }
                    // System / result events are metadata only —
                    // skip them; the UI doesn't render them.
                    _ => {}
                }
            }
            Err(_) => break,
        }
    }

    Ok(messages)
}

fn extract_user_blocks(v: &serde_json::Value) -> (String, Vec<LoadedToolResult>) {
    let mut text = String::new();
    let mut results: Vec<LoadedToolResult> = Vec::new();
    let content = v.get("message").and_then(|m| m.get("content"));
    if let Some(s) = content.and_then(|c| c.as_str()) {
        text.push_str(s);
        return (text, results);
    }
    if let Some(arr) = content.and_then(|c| c.as_array()) {
        for block in arr {
            let bt = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
            if bt == "text" {
                if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                    if !text.is_empty() {
                        text.push('\n');
                    }
                    text.push_str(t);
                }
            } else if bt == "tool_result" {
                let tool_use_id = block
                    .get("tool_use_id")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                // Content here can be a string or an array of blocks.
                let body = match block.get("content") {
                    Some(serde_json::Value::String(s)) => s.clone(),
                    Some(serde_json::Value::Array(items)) => items
                        .iter()
                        .filter_map(|b| {
                            let bt = b.get("type").and_then(|x| x.as_str())?;
                            if bt == "text" {
                                b.get("text").and_then(|x| x.as_str()).map(|s| s.to_string())
                            } else if bt == "image" {
                                Some("[image]".to_string())
                            } else {
                                None
                            }
                        })
                        .collect::<Vec<_>>()
                        .join("\n"),
                    _ => String::new(),
                };
                let is_error = block.get("is_error").and_then(|x| x.as_bool());
                results.push(LoadedToolResult {
                    tool_use_id,
                    content: body,
                    is_error,
                });
            }
        }
    }
    (text, results)
}

fn extract_assistant_blocks(v: &serde_json::Value) -> (String, Vec<LoadedToolCall>) {
    let mut text = String::new();
    let mut calls: Vec<LoadedToolCall> = Vec::new();
    let content = v
        .get("message")
        .and_then(|m| m.get("content"))
        .and_then(|c| c.as_array());
    let Some(arr) = content else {
        return (text, calls);
    };
    for block in arr {
        let bt = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
        if bt == "text" {
            if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                if !text.is_empty() {
                    text.push('\n');
                }
                text.push_str(t);
            }
        } else if bt == "tool_use" {
            calls.push(LoadedToolCall {
                id: block
                    .get("id")
                    .and_then(|x| x.as_str())
                    .map(|s| s.to_string()),
                function: LoadedToolFunction {
                    name: block
                        .get("name")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    arguments: block
                        .get("input")
                        .cloned()
                        .unwrap_or(serde_json::Value::Object(Default::default())),
                },
            });
        }
    }
    (text, calls)
}

/// Encode an absolute filesystem path the same way Claude Code does
/// when storing sessions: lowercase the drive letter (Windows only),
/// then replace any character that's not alphanumeric or '-' with '-'.
/// Verified against `~/.claude/projects/` entries on Windows + WSL.
fn encode_project_path(cwd: &str) -> String {
    let mut s = cwd.to_string();
    #[cfg(windows)]
    {
        // "C:\Users\..." → "c:\Users\..." before the punctuation pass.
        if s.len() >= 2 && s.as_bytes()[1] == b':' {
            let first = s.chars().next().unwrap().to_lowercase().to_string();
            s = first + &s[1..];
        }
    }
    s.chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || c == '-' {
                c
            } else {
                '-'
            }
        })
        .collect()
}

/// Extract the user-visible text from a stream-json `user` entry.
/// Handles both string and array-of-blocks shapes; returns None when
/// the entry only contains tool_result / image blocks.
fn extract_user_text(v: &serde_json::Value) -> Option<String> {
    let msg = v.get("message")?;
    let content = msg.get("content")?;
    if let Some(s) = content.as_str() {
        return Some(s.to_string());
    }
    if let Some(arr) = content.as_array() {
        let mut out = String::new();
        for block in arr {
            let bt = block.get("type").and_then(|x| x.as_str()).unwrap_or("");
            if bt == "text" {
                if let Some(t) = block.get("text").and_then(|x| x.as_str()) {
                    if !out.is_empty() {
                        out.push('\n');
                    }
                    out.push_str(t);
                }
            }
        }
        if !out.is_empty() {
            return Some(out);
        }
    }
    None
}

fn trim_oneline(s: &str, max: usize) -> String {
    let line = s.lines().next().unwrap_or("").trim();
    if line.chars().count() <= max {
        return line.to_string();
    }
    let mut out: String = line.chars().take(max).collect();
    out.push('…');
    out
}
