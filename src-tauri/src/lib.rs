mod env;
mod git;
mod lsp;
mod process;
mod terminal;
mod toolchains;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(terminal::Terminals::default())
        .manage(process::Jobs::default())
        .manage(lsp::LanguageServers::default())
        .invoke_handler(tauri::generate_handler![
            workspace::read_dir,
            workspace::read_file,
            workspace::write_file,
            workspace::create_path,
            workspace::rename_path,
            workspace::trash_path,
            workspace::list_files,
            workspace::search_text,
            git::git_status,
            git::git_init,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_head_content,
            git::git_branches,
            git::git_checkout,
            git::git_sync,
            terminal::terminal_spawn,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            process::job_cancel,
            lsp::lsp_start,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::dap_start,
            toolchains::ios::setup::ios_health,
            toolchains::android::setup::android_health,
            toolchains::android::project::android_project_info,
            toolchains::android::project::project_platform,
            toolchains::android::project::android_find_source,
            toolchains::android::build::android_build,
            toolchains::android::devices::android_devices,
            toolchains::android::devices::android_pair,
            toolchains::android::devices::android_connect,
            toolchains::android::run::android_run,
            toolchains::ios::project::ios_project_info,
            toolchains::ios::project::ios_configure_lsp,
            toolchains::ios::build::ios_build,
            toolchains::ios::devices::ios_devices,
            toolchains::ios::run::ios_run,
            toolchains::ios::archive::ios_archive,
            toolchains::ios::dependencies::ios_dependencies,
            toolchains::ios::dependencies::ios_add_dependency,
            toolchains::ios::signing::ios_signing_info,
            toolchains::ios::signing::ios_save_signing,
            toolchains::ios::templates::ios_new_project,
            toolchains::ios::templates::ios_regenerate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
