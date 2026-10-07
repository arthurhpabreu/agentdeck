// Module declarations
mod agent_models;
mod agent_observability;
mod chat;
mod cli_detect;
mod cli_updates;
mod git;
mod hooks;
mod i18n;
mod integration_control;
mod knowledge;
mod memory_capture;
mod memory_gemini;
mod memory_intelligence_runtime;
mod memory_retrieval;
pub mod memory_runtime;
mod notification;
mod provider_sessions;
pub mod provider_usage;
mod pty;
mod rtk_hook;
mod runner;
mod runtime_scope;
mod session_files;
mod session_lifecycle;
mod shared_memory;
mod state;
mod token_economy;
mod ui_state;
mod util;
mod window;

use state::{
    GitWatcherMap, PopupVisible, PreExpandPos, ProcessMap, PtyKillerMap, PtyMasterMap,
    PtySessionMetaMap, PtyWriterMap, RestoringLock,
};
use tauri::{
    image::Image,
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    Manager, WebviewUrl, WebviewWindowBuilder,
};

// macOS PATH configuration

/// GUI app launches have a minimal PATH; add Homebrew and other common locations.
#[cfg(target_os = "macos")]
fn fix_path_env() {
    use std::env;
    let current = env::var("PATH").unwrap_or_default();
    let extra = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin"];
    let mut parts: Vec<&str> = current.split(':').collect();
    for dir in extra.iter().rev() {
        if !parts.contains(dir) {
            parts.insert(0, dir);
        }
    }
    env::set_var("PATH", parts.join(":"));
}

// Application entry point

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "macos")]
    fix_path_env();

    let context = tauri::generate_context!();

    let builder = tauri::Builder::default();
    #[cfg(not(debug_assertions))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
        // Reuse the running instance and focus its window on repeated launches.
        window::show_popup_only(app.clone());
    }));

    let builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .manage(i18n::LocaleState::default())
        .manage(ProcessMap::default())
        .manage(chat::ChatProcessState::default())
        .manage(PtyWriterMap::default())
        .manage(PtyKillerMap::default())
        .manage(PtyMasterMap::default())
        .manage(PtySessionMetaMap::default())
        .manage(GitWatcherMap::default())
        .manage(PopupVisible::new(false))
        .manage(PreExpandPos::new())
        .manage(RestoringLock::new())
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Regular);

            // Start CLI hook receivers (Unix sockets or Windows loopback TCP).
            hooks::start_hook_socket_servers(app.handle().clone());

            // Reconcile notifications and hooks with saved preferences at startup.
            match hooks::reconcile_integrations_on_startup(app.handle()) {
                Ok(message) => {
                    eprintln!("[hooks] startup reconcile ok: {message}");
                }
                Err(e) => {
                    eprintln!("[hooks] startup reconcile failed: {e}");
                }
            }

            // Hide the tiny bootstrap window; the workbench remains a regular taskbar window.
            if let Some(main_win) = app.get_webview_window("main") {
                let _ = main_win.hide();
            }

            // Precreate a hidden popup so the WebView can load in the background.
            // Restore saved dimensions, falling back to defaults.
            let (popup_w, popup_h) = window::load_bounds(app.handle())
                .map(|b| (b.width.max(1000.0), b.height.max(680.0)))
                .unwrap_or((1360.0, 900.0));
            let win = WebviewWindowBuilder::new(
                app.handle(),
                "popup",
                WebviewUrl::App("index.html".into()),
            )
            .title("Agentdeck")
            .inner_size(popup_w, popup_h)
            .decorations(false)
            .transparent(false)
            .always_on_top(false)
            .shadow(true)
            .min_inner_size(940.0, 640.0)
            .resizable(true)
            .skip_taskbar(false)
            .visible(false)
            .build()
            .expect("Failed to pre-create popup window");

            let close_handle = app.handle().clone();
            win.on_window_event(move |event| {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    close_handle.exit(0);
                }
            });

            #[cfg(target_os = "macos")]
            window::setup_popup_window(&win);

            window::position_popup(app.handle(), &win);
            window::show_popup(app.handle(), &win);

            // System tray
            let quit_item = MenuItem::with_id(app, "quit", "Quit Agentdeck", true, None::<&str>)?;
            let tray_menu = Menu::with_items(app, &[&quit_item])?;
            app.manage(state::TrayQuitItem(quit_item));
            let tray_icon = Image::from_bytes(include_bytes!("../icons/tray-icon.png"))?;

            let tray = TrayIconBuilder::new()
                .icon(tray_icon)
                .icon_as_template(false)
                .tooltip("Agentdeck")
                .menu(&tray_menu)
                .show_menu_on_left_click(false)
                .build(app)?;

            let app_handle = app.handle().clone();
            tray.on_tray_icon_event(move |_tray, event| {
                if let TrayIconEvent::Click {
                    button: MouseButton::Left,
                    button_state: MouseButtonState::Up,
                    ..
                } = event
                {
                    window::toggle_popup(&app_handle);
                }
            });

            let app_handle2 = app.handle().clone();
            app.on_menu_event(move |_app, event| {
                if event.id().as_ref() == "quit" {
                    app_handle2.exit(0);
                }
            });

            // Warm the CLI path cache in the background to reduce cold-start delays.
            std::thread::spawn(|| {
                for cli in &["node", "claude", "codex", "gemini"] {
                    let _ = cli_detect::resolve_command_path(cli);
                }
            });

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // Window controls
            window::close_popup,
            window::exit_app,
            agent_models::list_agent_models,
            cli_updates::check_cli_update,
            cli_updates::update_agent_cli,
            agent_observability::observe_agent_sessions,
            provider_usage::get_provider_usage,
            token_economy::get_token_economy_status,
            token_economy::set_token_economy_enabled,
            chat::start_chat_turn,
            chat::steer_chat_turn,
            chat::stop_chat_turn,
            chat::save_chat_attachment,
            window::focus_popup,
            window::resize_popup,
            window::resize_popup_full,
            window::pick_folder,
            knowledge::get_knowledge_config,
            knowledge::set_knowledge_source,
            knowledge::search_knowledge,
            knowledge::get_knowledge_graph,
            knowledge::read_knowledge_note,
            memory_runtime::memory_status,
            memory_runtime::memory_open_storage,
            memory_runtime::memory_export_markdown,
            memory_runtime::memory_list,
            memory_runtime::memory_save,
            memory_runtime::memory_set_pinned,
            memory_runtime::memory_delete,
            memory_runtime::memory_configure,
            memory_runtime::memory_reset_session,
            memory_intelligence_runtime::memory_catalog,
            memory_intelligence_runtime::memory_update_project,
            memory_intelligence_runtime::memory_attach_project,
            memory_intelligence_runtime::memory_profile,
            memory_intelligence_runtime::memory_curation_status,
            memory_intelligence_runtime::memory_set_curation_enabled,
            memory_intelligence_runtime::memory_review_profile,
            memory_intelligence_runtime::memory_metadata,
            memory_intelligence_runtime::memory_set_metadata,
            memory_intelligence_runtime::memory_versions,
            memory_intelligence_runtime::memory_restore_version,
            memory_intelligence_runtime::memory_inactive,
            memory_intelligence_runtime::memory_maintain,
            memory_intelligence_runtime::memory_export_incremental,
            memory_intelligence_runtime::memory_retrieval_preview,
            window::save_popup_bounds,
            window::load_popup_bounds,
            window::restore_popup_bounds,
            // Runner (child-process mode)
            runner::start_runner,
            runner::stop_runner,
            runner::start_claude_session,
            runner::stop_claude_session,
            // CLI detection
            cli_detect::check_cli,
            cli_detect::debug_env,
            // Git diff
            git::diff::get_git_diff,
            git::diff::get_git_diff_branch,
            git::diff::get_git_diff_session_worktree,
            git::status::get_git_status,
            git::content::get_git_diff_side,
            git::actions::git_stage_file,
            git::actions::git_unstage_file,
            git::actions::git_discard_file,
            git::actions::git_commit_staged,
            git::actions::git_stage_all,
            git::actions::git_stage_paths,
            git::actions::git_unstage_all,
            git::actions::git_stage_hunk,
            git::actions::git_unstage_hunk,
            git::actions::git_discard_hunk,
            git::conflict::git_read_conflict_file,
            git::conflict::git_resolve_conflict,
            git::watch::start_git_watch,
            git::watch::stop_git_watch,
            // Session files
            session_files::remember_session_workdir,
            session_files::remove_session_workdir,
            session_files::read_session_file,
            session_files::write_session_file,
            session_files::list_session_directory,
            // Git branch management
            git::branch::git_current_branch,
            git::branch::git_branch_create,
            git::branch::git_branch_switch,
            git::branch::git_branch_delete,
            git::branch::git_branch_merge,
            git::branch::git_repo_info,
            // Git worktree management
            git::worktree::git_worktree_create,
            git::worktree::git_worktree_remove,
            git::worktree::git_worktree_list,
            git::worktree::git_worktree_merge,
            git::worktree::setup_session_worktree,
            git::worktree::teardown_session_worktree,
            git::worktree::prune_orphan_worktrees,
            // PTY terminals
            pty::start_pty_session,
            pty::write_pty,
            pty::resize_pty,
            pty::stop_pty_session,
            pty::send_pty_query,
            // Notifications and hooks
            hooks::send_notification,
            i18n::set_app_locale,
            hooks::setup_all_hooks,
            hooks::setup_claude_hooks,
            hooks::setup_codex_hooks,
            hooks::set_notifications_and_hooks_enabled,
            hooks::get_notifications_and_hooks_status,
            hooks::trust_workspace,
            // Native notifications with click callbacks (persistent waiting on macOS).
            notification::send_notification_with_callback,
            ui_state::load_ui_states,
            ui_state::load_deleted_ui_state,
            ui_state::mark_deleted_items,
            ui_state::clear_deleted_items,
            ui_state::save_ui_state,
            ui_state::remove_ui_state,
            ui_state::reserve_session_id,
            ui_state::recover_workspace_sessions,
            ui_state::save_recovery_binding,
            ui_state::backfill_workspace_session_bindings,
        ]);

    let app = builder
        .build(context)
        .expect("error while building tauri application");

    app.run(|app, event| {
        if let tauri::RunEvent::Exit = event {
            chat::stop_all_chat_processes(app);
            let ids: Vec<String> = app
                .state::<PtyKillerMap>()
                .lock()
                .unwrap()
                .keys()
                .cloned()
                .collect();
            for id in ids {
                let _ = pty::stop_pty_session(app.clone(), id);
            }
            let process_state = app.state::<ProcessMap>();
            let mut processes = process_state.lock().unwrap();
            for (_, mut child) in processes.drain() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            window::show_popup_only(app.clone());
        }
    });
}
