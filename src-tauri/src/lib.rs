mod claude_code;
mod claude_mcp;
mod claude_perm;
mod fs_ops;
mod git;
mod pty;
mod search;
mod watcher;
mod workspace;

use claude_code::ClaudeCodeState;
use claude_perm::PermState;
use pty::PtyState;
use watcher::WatcherState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyState::default())
        .manage(WatcherState::default())
        .manage(ClaudeCodeState::default())
        .manage(PermState::default())
        .setup(|app| {
            // Start the permission-callback HTTP server early so
            // settings.local.json hooks always have an endpoint to
            // POST to. Best-effort — log + continue if it fails so
            // the app still launches in dangerously-skip-permissions
            // fallback mode.
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                if let Err(e) = claude_perm::start_server(handle) {
                    eprintln!("[claude_perm] failed to start server: {}", e);
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            fs_ops::list_dir,
            fs_ops::read_file,
            fs_ops::write_file,
            fs_ops::rename_path,
            fs_ops::delete_path,
            fs_ops::create_dir,
            fs_ops::path_exists,
            fs_ops::create_file,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_list_sessions,
            pty::pty_session_exists,
            pty::pty_get_buffer,
            pty::available_shells,
            workspace::workspaces_load,
            workspace::workspaces_save,
            workspace::workspace_state_load,
            workspace::workspace_state_save,
            watcher::fs_watch_start,
            watcher::fs_watch_stop,
            git::git_is_repo,
            git::git_status,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_pull,
            git::git_push,
            git::git_fetch,
            git::git_init,
            search::list_workspace_files,
            search::search_text,
            search::scan_todos,
            search::read_package_scripts,
            git::git_diff,
            git::git_diff_staged,
            git::git_show,
            git::git_discard,
            git::git_branches,
            git::git_checkout_branch,
            claude_code::claude_code_check,
            claude_code::claude_code_chat,
            claude_code::claude_code_kill,
            claude_code::claude_code_list_sessions,
            claude_code::claude_code_load_session,
            claude_perm::claude_perm_decide,
            claude_perm::claude_perm_endpoint,
            claude_mcp::claude_mcp_list,
            claude_mcp::claude_mcp_add,
            claude_mcp::claude_mcp_remove,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
