//! MCP server management for Claude Code.
//!
//! Claude Code reads MCP server configs from two scopes:
//!   - User: `~/.claude.json` under `mcpServers` — applies to every
//!     project for this user.
//!   - Project: `<workspace>/.mcp.json` under `mcpServers` — checked
//!     into git, shared with collaborators.
//!
//! Both files are JSON with the same shape:
//!   {
//!     "mcpServers": {
//!       "filesystem": {
//!         "command": "npx",
//!         "args": ["-y", "@modelcontextprotocol/server-filesystem", "/data"],
//!         "env": {}
//!       },
//!       ...
//!     }
//!   }
//!
//! This module surfaces the merged list (with source labels) to the
//! frontend, plus add/remove operations. The user-scope footgun
//! (anthropics/claude-code#16728) is mitigated by always labeling
//! the source in the returned list so the UI can warn.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Write a JSON file atomically — delegates to crate::atomic which
/// uses the same .codetta-tmp suffix and rename-then-cleanup-on-fail
/// pattern across every module that needs durable writes. Important
/// for ~/.claude.json specifically: Claude Code reads it on every
/// invocation, so a truncated copy breaks the user's entire CLI
/// workflow until they hand-edit it.
fn write_json_atomic(target: &Path, contents: &str) -> Result<(), String> {
    crate::atomic::write(target, contents.as_bytes()).map_err(|e| e.to_string())
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct McpServer {
    pub name: String,
    /// "user" or "project" — where the server config lives.
    pub scope: String,
    /// Transport: "stdio" (local command) or "http" / "sse" (remote URL).
    /// Claude Code keys remote servers off a `type` field; local ones
    /// have a `command`. We surface this so the UI can render each kind.
    pub transport: String,
    /// Command to launch the server (typically `npx`, `node`, `python`, …).
    /// Empty for remote (http/sse) servers.
    #[serde(default)]
    pub command: String,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub args: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub env: BTreeMap<String, String>,
    /// Endpoint URL for remote (http/sse) servers; None for stdio.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    /// Optional HTTP headers for remote servers (e.g. Authorization).
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub headers: BTreeMap<String, String>,
}

fn user_config_path() -> Result<PathBuf, String> {
    let home = dirs::home_dir().ok_or_else(|| "no home dir".to_string())?;
    Ok(home.join(".claude.json"))
}

fn project_config_path(workspace: &str) -> PathBuf {
    Path::new(workspace).join(".mcp.json")
}

fn read_servers_from(path: &Path, scope: &str) -> Vec<McpServer> {
    let s = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(_) => return Vec::new(),
    };
    let v: serde_json::Value = match serde_json::from_str(&s) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let Some(obj) = v.get("mcpServers").and_then(|x| x.as_object()) else {
        return Vec::new();
    };
    let mut out = Vec::with_capacity(obj.len());
    for (name, def) in obj {
        let command = def
            .get("command")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        let args = def
            .get("args")
            .and_then(|x| x.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|a| a.as_str().map(|s| s.to_string()))
                    .collect()
            })
            .unwrap_or_default();
        let env = parse_string_map(def.get("env"));
        let url = def
            .get("url")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let headers = parse_string_map(def.get("headers"));
        // Transport: explicit `type` wins (remote http/sse); otherwise a
        // `url` with no command implies remote; else it's a local stdio
        // command server.
        let transport = match def.get("type").and_then(|x| x.as_str()) {
            Some("http") => "http".to_string(),
            Some("sse") => "sse".to_string(),
            _ if url.is_some() && command.is_empty() => "http".to_string(),
            _ => "stdio".to_string(),
        };
        out.push(McpServer {
            name: name.clone(),
            scope: scope.to_string(),
            transport,
            command,
            args,
            env,
            url,
            headers,
        });
    }
    out
}

fn parse_string_map(v: Option<&serde_json::Value>) -> BTreeMap<String, String> {
    v.and_then(|x| x.as_object())
        .map(|o| {
            o.iter()
                .filter_map(|(k, val)| val.as_str().map(|s| (k.clone(), s.to_string())))
                .collect()
        })
        .unwrap_or_default()
}

/// List every MCP server reachable from this workspace, merged from
/// both user and project scopes. Both sources are returned (not
/// dedup'd) so the UI can warn when a project entry shadows a user
/// entry — the documented user-scope footgun in
/// anthropics/claude-code#16728.
#[tauri::command]
pub fn claude_mcp_list(cwd: String) -> Result<Vec<McpServer>, String> {
    let mut out: Vec<McpServer> = Vec::new();
    if let Ok(path) = user_config_path() {
        if path.exists() {
            out.extend(read_servers_from(&path, "user"));
        }
    }
    let project = project_config_path(&cwd);
    if project.exists() {
        out.extend(read_servers_from(&project, "project"));
    }
    out.sort_by(|a, b| a.name.cmp(&b.name).then(a.scope.cmp(&b.scope)));
    Ok(out)
}

/// Add (or replace) an MCP server in the given scope. `scope` must
/// be "user" or "project". Returns the path of the file that was
/// written so the UI can show a confirmation toast.
#[tauri::command]
pub fn claude_mcp_add(
    cwd: String,
    name: String,
    scope: String,
    command: String,
    args: Vec<String>,
    env: BTreeMap<String, String>,
) -> Result<String, String> {
    let target = match scope.as_str() {
        "user" => user_config_path()?,
        "project" => project_config_path(&cwd),
        other => return Err(format!("unknown scope: {}", other)),
    };
    write_server(&target, &name, &command, &args, &env)?;
    Ok(target.to_string_lossy().into_owned())
}

/// Add (or replace) a remote (HTTP / SSE) MCP server in the given scope.
/// `transport` must be "http" or "sse". Returns the written file path.
#[tauri::command]
pub fn claude_mcp_add_remote(
    cwd: String,
    name: String,
    scope: String,
    transport: String,
    url: String,
    headers: BTreeMap<String, String>,
) -> Result<String, String> {
    if transport != "http" && transport != "sse" {
        return Err(format!("unknown transport: {}", transport));
    }
    let target = match scope.as_str() {
        "user" => user_config_path()?,
        "project" => project_config_path(&cwd),
        other => return Err(format!("unknown scope: {}", other)),
    };
    let entry = if headers.is_empty() {
        serde_json::json!({ "type": transport, "url": url })
    } else {
        serde_json::json!({ "type": transport, "url": url, "headers": headers })
    };
    write_entry(&target, &name, entry)?;
    Ok(target.to_string_lossy().into_owned())
}

/// Remove an MCP server from the given scope. No-op if it doesn't
/// exist there (so UI can call this without checking).
#[tauri::command]
pub fn claude_mcp_remove(
    cwd: String,
    name: String,
    scope: String,
) -> Result<(), String> {
    let target = match scope.as_str() {
        "user" => user_config_path()?,
        "project" => project_config_path(&cwd),
        other => return Err(format!("unknown scope: {}", other)),
    };
    if !target.exists() {
        return Ok(());
    }
    let s = fs::read_to_string(&target).map_err(|e| e.to_string())?;
    // Reject malformed JSON instead of silently overwriting the
    // user's settings file with an empty object — which would lose
    // every MCP / setting / hook they have configured.
    let mut v: serde_json::Value = serde_json::from_str(&s).map_err(|e| {
        format!(
            "{} is not valid JSON ({}). Refusing to overwrite — fix the file first.",
            target.display(),
            e
        )
    })?;
    if !v.is_object() {
        return Err(format!(
            "{} root is not a JSON object. Refusing to overwrite.",
            target.display()
        ));
    }
    if let Some(obj) = v.get_mut("mcpServers").and_then(|x| x.as_object_mut()) {
        obj.remove(&name);
    }
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    write_json_atomic(&target, &pretty)?;
    Ok(())
}

fn write_server(
    target: &Path,
    name: &str,
    command: &str,
    args: &[String],
    env: &BTreeMap<String, String>,
) -> Result<(), String> {
    let entry = serde_json::json!({
        "command": command,
        "args": args,
        "env": env,
    });
    write_entry(target, name, entry)
}

/// Insert a prebuilt server entry (stdio or remote) under
/// `mcpServers[name]`, preserving the rest of the config file. Shared by
/// both the stdio and remote add paths.
fn write_entry(
    target: &Path,
    name: &str,
    entry: serde_json::Value,
) -> Result<(), String> {
    if let Some(parent) = target.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let mut v: serde_json::Value = if target.exists() {
        let s = fs::read_to_string(target).map_err(|e| e.to_string())?;
        // Same defensive parse as the remove path — refuse to
        // proceed if the existing file is malformed, rather than
        // silently overwriting the user's settings with `{}`.
        serde_json::from_str::<serde_json::Value>(&s).map_err(|e| {
            format!(
                "{} is not valid JSON ({}). Refusing to overwrite — fix the file first.",
                target.display(),
                e
            )
        })?
    } else {
        serde_json::json!({})
    };
    if !v.is_object() {
        return Err(format!(
            "{} root is not a JSON object. Refusing to overwrite.",
            target.display()
        ));
    }
    let root = v.as_object_mut().unwrap();
    let servers = root
        .entry("mcpServers".to_string())
        .or_insert_with(|| serde_json::json!({}));
    if !servers.is_object() {
        *servers = serde_json::json!({});
    }
    servers
        .as_object_mut()
        .unwrap()
        .insert(name.to_string(), entry);
    let pretty = serde_json::to_string_pretty(&v).map_err(|e| e.to_string())?;
    write_json_atomic(target, &pretty)?;
    Ok(())
}
