mod ai;
mod children;
mod env;
mod git;
mod lifecycle;
mod logging;
mod lsp;
mod process;
mod terminal;
mod toolchains;
mod updater;
mod watcher;
mod workspace;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    logging::install_panic_hook();
    logging::write(concat!("Orbit ", env!("CARGO_PKG_VERSION"), " starting"));
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(terminal::Terminals::default())
        .manage(process::Jobs::default())
        .manage(lsp::LanguageServers::default())
        .manage(watcher::Watcher::default())
        .invoke_handler(tauri::generate_handler![
            ai::hardware::ai_hardware,
            ai::models::ai_models,
            ai::models::ai_download,
            ai::models::ai_download_stop,
            ai::models::ai_delete_model,
            ai::models::ai_import_model,
            ai::server::ai_status,
            ai::server::ai_unload,
            ai::server::ai_configure,
            ai::chat::ai_chat,
            ai::chat::ai_cancel,
            ai::chat::ai_tokenize,
            ai::chat::ai_infill,
            ai::history::ai_history_load,
            ai::history::ai_history_save,
            lifecycle::app_quit,
            lifecycle::app_quit_ack,
            lifecycle::app_quit_cancel,
            logging::log_write,
            logging::log_path,
            logging::app_info,
            updater::update_check,
            updater::update_install,
            watcher::watch_root,
            workspace::read_dir,
            workspace::read_file,
            workspace::write_file,
            workspace::create_path,
            workspace::rename_path,
            workspace::trash_path,
            workspace::list_files,
            workspace::search_text,
            workspace::replace_in_files,
            git::git_status,
            git::git_init,
            git::git_stage,
            git::git_unstage,
            git::git_discard,
            git::git_commit,
            git::git_head_content,
            git::git_file_at,
            git::git_log,
            git::git_commit_files,
            git::git_blame,
            git::git_stash,
            git::git_branches,
            git::git_checkout,
            git::git_sync,
            terminal::terminal_spawn,
            terminal::terminal_attach,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_kill,
            process::job_cancel,
            lsp::lsp_start,
            lsp::lsp_attach,
            lsp::lsp_send,
            lsp::lsp_stop,
            lsp::dap_start,
            toolchains::device_view::device_screenshot,
            toolchains::device_view::device_save_screenshot,
            toolchains::device_view::device_input,
            toolchains::device_view::device_control,
            toolchains::device_view::device_app_id,
            toolchains::device_view::device_app_tool,
            toolchains::device_view::device_record_start,
            toolchains::device_view::device_record_stop,
            toolchains::ios::setup::ios_health,
            toolchains::android::setup::android_health,
            toolchains::android::project::android_project_info,
            toolchains::android::project::project_platform,
            toolchains::android::project::android_find_source,
            toolchains::android::build::android_build,
            toolchains::android::devices::android_devices,
            toolchains::android::devices::android_pair,
            toolchains::android::devices::android_connect,
            toolchains::android::devices::android_mdns_services,
            toolchains::android::devices::android_emulator_stop,
            toolchains::android::avds::android_avd_options,
            toolchains::android::avds::android_avd_create,
            toolchains::android::avds::android_avd_action,
            toolchains::android::run::android_run,
            toolchains::android::run::android_logcat,
            toolchains::android::lsp::android_language_server,
            toolchains::android::templates::android_new_project,
            toolchains::android::signing::android_signing_info,
            toolchains::version::app_version,
            toolchains::version::set_app_version,
            toolchains::app_settings::app_settings,
            toolchains::app_settings::save_app_settings,
            toolchains::icons::generate_app_icons,
            toolchains::android::signing::android_create_keystore,
            toolchains::android::signing::android_save_signing,
            toolchains::android::bundle::android_archive,
            toolchains::ios::project::ios_project_info,
            toolchains::ios::project::ios_configure_lsp,
            toolchains::ios::build::ios_build,
            toolchains::ios::test::ios_test,
            toolchains::ios::build::ios_project_action,
            toolchains::ios::dependencies::ios_pods_status,
            toolchains::ios::dependencies::ios_pod_install,
            toolchains::android::build::android_clean,
            toolchains::android::test::android_test,
            toolchains::ios::devices::ios_devices,
            toolchains::ios::simulators::ios_simulator_options,
            toolchains::ios::simulators::ios_simulator_create,
            toolchains::ios::simulators::ios_simulator_action,
            toolchains::ios::run::ios_run,
            toolchains::ios::archive::ios_archive,
            toolchains::ios::dependencies::ios_dependencies,
            toolchains::ios::dependencies::ios_add_dependency,
            toolchains::ios::signing::ios_signing_info,
            toolchains::ios::signing::ios_save_signing,
            toolchains::ios::templates::ios_new_project,
            toolchains::ios::templates::ios_regenerate,
        ])
        .setup(|app| {
            ai::server::spawn_idle_unloader(app.handle().clone());
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(lifecycle::on_run_event);
}
