mod fs_ops;
mod pty;
mod workspace;

use pty::PtyState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(PtyState::default())
        .invoke_handler(tauri::generate_handler![
            fs_ops::list_dir,
            fs_ops::read_file,
            fs_ops::write_file,
            fs_ops::rename_path,
            fs_ops::delete_path,
            fs_ops::create_dir,
            fs_ops::path_exists,
            pty::pty_spawn,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            workspace::workspaces_load,
            workspace::workspaces_save,
            workspace::workspace_state_load,
            workspace::workspace_state_save,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
