//! Localhost HTTP endpoint that the Claude Code CLI's `PreToolUse`
//! hook calls to request permission for each tool invocation. The hook
//! POSTs the tool call as JSON; we forward it to the frontend as a
//! Tauri event, wait synchronously for the user's decision (allow /
//! deny), then return the matching exit-code semantics so Claude Code
//! continues or blocks the call.
//!
//! Why HTTP and not Tauri IPC?
//!   - The hook command in `.claude/settings.local.json` is a shell
//!     command, not a JS callback. It needs to talk to *something*
//!     reachable from a child process spawned by claude.
//!   - HTTP is the only mechanism that works identically on Windows /
//!     macOS / Linux without shipping a sidecar binary.
//!   - We use `tiny_http` (sync, no async runtime) so the request
//!     thread can simply `block_on` a channel response.
//!
//! Why a fixed port?
//!   - The settings.local.json hook URL bakes in the port. Random
//!     ports would force us to rewrite the file every app launch.
//!   - We pick 14272 as a unlikely-to-collide default. If it's taken,
//!     we fall back to a random port and rewrite settings on each
//!     workspace open.

use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::mpsc;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use tiny_http::{Method, Response, Server};
use uuid::Uuid;

const DEFAULT_PORT: u16 = 14272;

/// User decision on a permission request. The HTTP server translates
/// these to the exit-code semantics Claude Code expects from a hook:
///   - Allow → exit 0 (let the tool run)
///   - Deny  → exit 2 (block the tool, agent treats as a failure)
#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PermDecision {
    Allow,
    Deny,
}

/// In-flight permission requests: request_id -> reply channel sender.
/// Each pending HTTP handler thread parks on its receiver waiting for
/// the frontend to POST back via `claude_perm_decide`.
type PendingMap = Arc<Mutex<HashMap<String, mpsc::Sender<PermDecision>>>>;

#[derive(Default)]
pub struct PermState {
    pub port: Mutex<Option<u16>>,
    pub pending: PendingMap,
}

/// Payload emitted to the frontend when a hook requests permission.
/// The frontend renders a card and eventually calls back via
/// `claude_perm_decide(request_id, decision)`.
#[derive(Serialize, Clone)]
pub struct PermissionRequest {
    pub request_id: String,
    /// Tool name as Claude Code knows it (Edit, Bash, Read, etc.).
    pub tool_name: String,
    /// Tool input as raw JSON — frontend renders tool-specific UX.
    pub tool_input: serde_json::Value,
    /// Workspace cwd Claude Code is operating in. Lets the frontend
    /// route the card to the right open AI chat panel when multiple
    /// workspaces are open simultaneously.
    pub cwd: Option<String>,
    /// Session id from the stream — pairs the request with whichever
    /// chat panel is currently driving that session.
    pub session_id: Option<String>,
}

/// Spawn the permission-callback HTTP server. Idempotent — if the
/// server is already running (port set in state), this is a no-op.
/// Tries the fixed default port first; if that's taken, takes a random
/// free one and we rewrite settings.local.json per workspace.
pub fn start_server(app: AppHandle) -> Result<u16, String> {
    if let Some(state) = app.try_state::<PermState>() {
        if let Some(port) = *state.port.lock() {
            return Ok(port);
        }
        let server = match Server::http(format!("127.0.0.1:{}", DEFAULT_PORT)) {
            Ok(s) => s,
            Err(_) => Server::http("127.0.0.1:0")
                .map_err(|e| format!("failed to bind permission server: {}", e))?,
        };
        let actual_port = server
            .server_addr()
            .to_ip()
            .map(|s| s.port())
            .ok_or_else(|| "no port from bound server".to_string())?;
        *state.port.lock() = Some(actual_port);

        let pending = Arc::clone(&state.pending);
        let app_handle = app.clone();
        thread::spawn(move || {
            for request in server.incoming_requests() {
                handle_request(request, &app_handle, &pending);
            }
        });
        Ok(actual_port)
    } else {
        Err("permission state not registered with app".to_string())
    }
}

fn handle_request(
    mut request: tiny_http::Request,
    app: &AppHandle,
    pending: &PendingMap,
) {
    if request.method() != &Method::Post {
        let _ = request.respond(Response::from_string("expected POST").with_status_code(405));
        return;
    }

    // The hook command POSTs the tool call as JSON on stdin →
    // curl forwards it as the request body. Shape per Claude Code's
    // PreToolUse hook contract:
    //   {
    //     "session_id": "...",
    //     "transcript_path": "...",
    //     "cwd": "...",
    //     "hook_event_name": "PreToolUse",
    //     "tool_name": "Edit",
    //     "tool_input": { ... }
    //   }
    let mut body = String::new();
    if request.as_reader().read_to_string(&mut body).is_err() {
        let _ = request.respond(Response::from_string("bad body").with_status_code(400));
        return;
    }
    let payload: serde_json::Value = match serde_json::from_str(&body) {
        Ok(v) => v,
        Err(_) => {
            // Default-allow on malformed payloads — better to let the
            // agent run than to block all tools because of a parse
            // failure on our end.
            let _ = request.respond(Response::from_string("ok").with_status_code(200));
            return;
        }
    };

    let request_id = Uuid::new_v4().to_string();
    let tool_name = payload
        .get("tool_name")
        .and_then(|v| v.as_str())
        .unwrap_or("unknown")
        .to_string();
    let tool_input = payload
        .get("tool_input")
        .cloned()
        .unwrap_or(serde_json::Value::Null);
    let cwd = payload
        .get("cwd")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());
    let session_id = payload
        .get("session_id")
        .and_then(|v| v.as_str())
        .map(|s| s.to_string());

    // Set up the reply channel BEFORE emitting the event so we can't
    // miss a fast frontend response.
    let (tx, rx) = mpsc::channel::<PermDecision>();
    pending.lock().insert(request_id.clone(), tx);

    let req_for_frontend = PermissionRequest {
        request_id: request_id.clone(),
        tool_name,
        tool_input,
        cwd,
        session_id,
    };
    let _ = app.emit("claude:permission-request", &req_for_frontend);

    // Block waiting for the user's decision. Long timeout — Claude
    // Code's hook also has a default timeout (60s); we go a bit higher
    // because the user might be away from keyboard.
    let decision = rx
        .recv_timeout(Duration::from_secs(300))
        .unwrap_or(PermDecision::Deny);

    // Clean up the pending entry.
    pending.lock().remove(&request_id);

    // Hook protocol: exit 0 = allow, exit 2 = deny. The hook command
    // we install reads our HTTP body for one of those numbers and
    // exits with it. So the response body literally is "0" or "2".
    let body = match decision {
        PermDecision::Allow => "0",
        PermDecision::Deny => "2",
    };
    let _ = request.respond(
        Response::from_string(body)
            .with_status_code(200)
            .with_header(
                tiny_http::Header::from_bytes(
                    &b"content-type"[..],
                    &b"text/plain; charset=utf-8"[..],
                )
                .unwrap(),
            ),
    );
}

/// Frontend → backend: report the user's decision for a pending
/// request. Wakes the HTTP handler thread that's blocked on the
/// matching reply channel.
#[tauri::command]
pub fn claude_perm_decide(
    state: tauri::State<'_, PermState>,
    request_id: String,
    decision: PermDecision,
) -> Result<(), String> {
    if let Some(tx) = state.pending.lock().remove(&request_id) {
        let _ = tx.send(decision);
        Ok(())
    } else {
        // Already timed out or never existed. Not an error per se —
        // the frontend may race a timeout.
        Ok(())
    }
}

/// Returns the URL the hook command should POST to. None if the
/// server hasn't started yet (shouldn't happen in normal use — we
/// start the server during app launch).
#[tauri::command]
pub fn claude_perm_endpoint(state: tauri::State<'_, PermState>) -> Option<String> {
    let port = *state.port.lock();
    port.map(|p| format!("http://127.0.0.1:{}/permission", p))
}
