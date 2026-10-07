// Native notifications with click callbacks on macOS.
//
// tauri-plugin-notification uses notify-rust. Although notify-rust depends on
// mac-notification-sys on macOS, it does not expose the notification click
// callbacks provided by that library.
//
// This module calls mac-notification-sys directly to:
//   1. Keep notifications available until user interaction; sending blocks until a response.
//   2. Route notification clicks through focus_popup(session_id).
//   3. Run on a separate thread without blocking the UI.

#[cfg(target_os = "macos")]
pub mod macos {
    use std::sync::OnceLock;

    static MAC_NOTIFICATION_APP_INIT: OnceLock<Result<(), String>> = OnceLock::new();

    /// Send a native macOS notification with a click callback.
    ///
    /// - Call `mac_notification_sys::send_notification` on a separate thread;
    ///   the call blocks until the user clicks, dismisses, or ignores the notification.
    /// - Route clicks on the notification body through `focus_popup(session_id)`.
    ///
    /// `subtitle` is optional; setting `sound` to true plays the default notification sound.
    pub fn send_with_click_callback(
        app: tauri::AppHandle,
        title: String,
        body: String,
        subtitle: Option<String>,
        sound: bool,
        session_id: Option<String>,
    ) {
        std::thread::spawn(move || {
            use mac_notification_sys::{set_application, Notification, Sound};

            // set_application can only succeed once; subsequent calls return an error.
            // OnceLock initializes it once per process and avoids intermittent initialization errors.
            let bundle_id = app.config().identifier.clone();
            let init_result = MAC_NOTIFICATION_APP_INIT
                .get_or_init(|| set_application(&bundle_id).map_err(|e| e.to_string()));
            if let Err(e) = init_result {
                // Development bundle identifiers may not be registered with LaunchServices,
                // so set_application can fail. Continue through mac_notification_sys using
                // the default application while preserving notification click callbacks.
                eprintln!(
                    "[notification] set_application({bundle_id}) failed, using the default notification application: {e}"
                );
            }

            // Use the Notification builder API:
            //   .wait_for_click(true) blocks for a click and returns Click instead of None.
            //   .asynchronous(false) enables synchronous behavior required for wait_for_click.
            let mut notif = Notification::new();
            notif.title(&title);
            notif.message(&body);
            notif.wait_for_click(true);
            notif.asynchronous(false);
            if sound {
                notif.sound(Sound::Default);
            }
            if let Some(ref sub) = subtitle {
                notif.subtitle(sub.as_str());
            }

            eprintln!("[notification] sending notification, waiting for click...");
            let response = notif.send();

            match response {
                Ok(mac_notification_sys::NotificationResponse::Click) => {
                    eprintln!("[notification] user clicked notification: {title}");
                    let sid = session_id.clone();
                    let app_for_focus = app.clone();
                    if let Err(err) = app.run_on_main_thread(move || {
                        crate::window::focus_popup(app_for_focus, sid);
                    }) {
                        eprintln!("[notification] run_on_main_thread(focus_popup) failed: {err}");
                    }
                }
                Ok(mac_notification_sys::NotificationResponse::ActionButton(ref action)) => {
                    eprintln!("[notification] action button clicked: {action}");
                    let sid = session_id.clone();
                    let app_for_focus = app.clone();
                    if let Err(err) = app.run_on_main_thread(move || {
                        crate::window::focus_popup(app_for_focus, sid);
                    }) {
                        eprintln!("[notification] run_on_main_thread(focus_popup) failed: {err}");
                    }
                }
                Ok(other) => {
                    eprintln!("[notification] notification dismissed/ignored: {other:?}");
                }
                Err(e) => {
                    eprintln!("[notification] send failed: {e:?}");
                }
            }
        });
    }
}

// Tauri command: shared notification entry point.

/// Send notifications using native macOS callbacks or tauri-plugin-notification elsewhere.
///
/// On macOS, notification clicks are routed through `focus_popup(session_id)`.
#[tauri::command]
pub fn send_notification_with_callback(
    app: tauri::AppHandle,
    title: String,
    body: String,
    subtitle: Option<String>,
    sound: Option<bool>,
    session_id: Option<String>,
) -> Result<(), String> {
    use tauri::Manager;

    if !crate::integration_control::notifications_and_hooks_enabled(&app) {
        eprintln!("[notification] skipped because notifications and hooks are disabled");
        return Ok(());
    }

    let play_sound = sound.unwrap_or(true);

    #[cfg(target_os = "macos")]
    {
        macos::send_with_click_callback(app, title, body, subtitle, play_sound, session_id);
        return Ok(());
    }

    // Use tauri-plugin-notification on other platforms.
    #[cfg(not(target_os = "macos"))]
    {
        use tauri_plugin_notification::NotificationExt;
        let _ = subtitle; // Avoid an unused-variable warning.
        let _ = play_sound;
        let _ = session_id;
        eprintln!(
            "[notification] desktop send requested: title={title:?} body_len={}",
            body.chars().count()
        );
        app.notification()
            .builder()
            .title(&title)
            .body(&body)
            .show()
            .map_err(|e| {
                crate::i18n::translate(
                    crate::i18n::current_locale(&app.state::<crate::i18n::LocaleState>()),
                    "notifications.send_failed",
                    &[("error", &e.to_string())],
                )
            })?;
        eprintln!("[notification] desktop send queued");
        Ok(())
    }
}
