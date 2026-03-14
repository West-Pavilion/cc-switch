#![allow(non_snake_case)]

use crate::session_manager;
use std::path::PathBuf;
use tauri_plugin_dialog::DialogExt;

#[tauri::command]
pub async fn list_sessions() -> Result<Vec<session_manager::SessionMeta>, String> {
    let sessions = tauri::async_runtime::spawn_blocking(session_manager::scan_sessions)
        .await
        .map_err(|e| format!("Failed to scan sessions: {e}"))?;
    Ok(sessions)
}

#[tauri::command]
pub async fn get_session_messages(
    providerId: String,
    sourcePath: String,
) -> Result<Vec<session_manager::SessionMessage>, String> {
    let provider_id = providerId.clone();
    let source_path = sourcePath.clone();
    tauri::async_runtime::spawn_blocking(move || {
        session_manager::load_messages(&provider_id, &source_path)
    })
    .await
    .map_err(|e| format!("Failed to load session messages: {e}"))?
}

#[tauri::command]
pub async fn launch_session_terminal(
    command: String,
    cwd: Option<String>,
    custom_config: Option<String>,
) -> Result<bool, String> {
    let command = command.clone();
    let cwd = cwd.clone();
    let custom_config = custom_config.clone();

    // Read preferred terminal from global settings
    let preferred = crate::settings::get_preferred_terminal();
    // Map global setting terminal names to session terminal names
    // Global uses "iterm2", session terminal uses "iterm"
    let target = match preferred.as_deref() {
        Some("iterm2") => "iterm".to_string(),
        Some(t) => t.to_string(),
        None => "terminal".to_string(), // Default to Terminal.app on macOS
    };

    tauri::async_runtime::spawn_blocking(move || {
        session_manager::terminal::launch_terminal(
            &target,
            &command,
            cwd.as_deref(),
            custom_config.as_deref(),
        )
    })
    .await
    .map_err(|e| format!("Failed to launch terminal: {e}"))??;

    Ok(true)
}

#[tauri::command]
pub async fn delete_session(
    providerId: String,
    sessionId: String,
    sourcePath: String,
) -> Result<bool, String> {
    let provider_id = providerId.clone();
    let session_id = sessionId.clone();
    let source_path = sourcePath.clone();

    tauri::async_runtime::spawn_blocking(move || {
        session_manager::delete_session(&provider_id, &session_id, &source_path)
    })
    .await
    .map_err(|e| format!("Failed to delete session: {e}"))?
}

#[tauri::command]
pub async fn save_session_export_dialog<R: tauri::Runtime>(
    app: tauri::AppHandle<R>,
    #[allow(non_snake_case)] defaultName: String,
) -> Result<Option<String>, String> {
    let dialog = app.dialog();
    let result = dialog
        .file()
        .add_filter("Markdown", &["md"])
        .add_filter("Text", &["txt"])
        .add_filter("JSON", &["json"])
        .set_file_name(&defaultName)
        .blocking_save_file();

    Ok(result.map(|p| p.to_string()))
}

#[tauri::command]
pub async fn export_session_transcript_to_file(
    #[allow(non_snake_case)] filePath: String,
    content: String,
) -> Result<bool, String> {
    let target_path = PathBuf::from(&filePath);

    tauri::async_runtime::spawn_blocking(move || {
        if let Some(parent) = target_path.parent() {
            if !parent.as_os_str().is_empty() {
                std::fs::create_dir_all(parent)
                    .map_err(|e| format!("Failed to prepare export directory: {e}"))?;
            }
        }

        std::fs::write(&target_path, content)
            .map_err(|e| format!("Failed to export session transcript: {e}"))?;

        Ok::<_, String>(true)
    })
    .await
    .map_err(|e| format!("Failed to export session transcript: {e}"))?
}
