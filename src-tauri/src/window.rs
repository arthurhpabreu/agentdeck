use std::path::PathBuf;

use tauri::{Emitter, Manager, WebviewUrl, WebviewWindowBuilder};

use crate::state::PopupVisible;
use crate::util::background_command;

macro_rules! popup_log {
    ($($arg:tt)*) => {{
        if std::env::var_os("AGENTDECK_POPUP_LOG").is_some() {
            eprintln!($($arg)*);
        }
    }};
}

// Persisted popup position and size

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
pub struct PopupBounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

fn bounds_file(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path()
        .app_data_dir()
        .ok()
        .map(|d| d.join("popup_bounds.json"))
}

/// Smallest popup worth restoring. A minimized window on Windows reports a frame of about
/// 150×20 at (-32000, -32000); restoring that reopens the popup tiny and off-screen.
const MIN_POPUP_WIDTH: f64 = 200.0;
const MIN_POPUP_HEIGHT: f64 = 120.0;

impl PopupBounds {
    fn is_usable_size(&self) -> bool {
        [self.x, self.y, self.width, self.height]
            .iter()
            .all(|v| v.is_finite())
            && self.width >= MIN_POPUP_WIDTH
            && self.height >= MIN_POPUP_HEIGHT
    }
}

/// Whether enough of `bounds` lies on a connected monitor for the user to see and drag it.
fn is_on_screen(win: &tauri::WebviewWindow, bounds: &PopupBounds) -> bool {
    let Ok(monitors) = win.available_monitors() else {
        return true;
    };
    monitors.iter().any(|monitor| {
        let scale = monitor.scale_factor();
        let left = monitor.position().x as f64 / scale;
        let top = monitor.position().y as f64 / scale;
        let right = left + monitor.size().width as f64 / scale;
        let bottom = top + monitor.size().height as f64 / scale;
        let visible_w = (bounds.x + bounds.width).min(right) - bounds.x.max(left);
        let visible_h = (bounds.y + bounds.height).min(bottom) - bounds.y.max(top);
        visible_w >= 100.0 && visible_h >= 40.0
    })
}

pub fn load_bounds(app: &tauri::AppHandle) -> Option<PopupBounds> {
    let path = bounds_file(app)?;
    let text = std::fs::read_to_string(&path).ok()?;
    serde_json::from_str::<PopupBounds>(&text)
        .ok()
        .filter(PopupBounds::is_usable_size)
}

/// Persists the popup frame unless it is the placeholder a minimized window reports, which
/// would make every later launch open invisible.
fn save_bounds_to_file(
    app: &tauri::AppHandle,
    win: &tauri::WebviewWindow,
    bounds: &PopupBounds,
) -> bool {
    if win.is_minimized().unwrap_or(false) || !bounds.is_usable_size() || !is_on_screen(win, bounds)
    {
        popup_log!(
            "[popup] bounds not saved (minimized or off-screen) => {:?}",
            bounds
        );
        return false;
    }
    if let Some(path) = bounds_file(app) {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(json) = serde_json::to_string(bounds) {
            let _ = std::fs::write(&path, json);
        }
    }
    true
}

// Tauri commands for persisting window bounds

/// Save popup bounds; the frontend calls this only while the window is collapsed.
/// Ignore calls during the 600 ms collapse guard so animation resize events do not overwrite saved bounds.
#[tauri::command]
pub fn save_popup_bounds(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) {
    // Skip disk writes while the collapse guard is active.
    if app.state::<crate::state::RestoringLock>().is_locked() {
        popup_log!("[popup] save_popup_bounds ignored (restoring lock active)");
        return;
    }
    let bounds = PopupBounds {
        x,
        y,
        width,
        height,
    };
    if save_bounds_to_file(&app, &window, &bounds) {
        popup_log!("[popup] bounds saved => x={x} y={y} w={width} h={height}");
    }
}

/// Read saved popup bounds, returning null when none are available.
#[tauri::command]
pub fn load_popup_bounds(app: tauri::AppHandle) -> Option<PopupBounds> {
    let b = load_bounds(&app);
    popup_log!("[popup] bounds loaded => {:?}", b);
    b
}

// Popup positioning: use saved bounds when available, otherwise center the window.

pub fn position_popup(app: &tauri::AppHandle, win: &tauri::WebviewWindow) {
    if let Some(bounds) = load_bounds(app).filter(|b| is_on_screen(win, b)) {
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition {
            x: bounds.x,
            y: bounds.y,
        }));
        let _ = win.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: bounds.width,
            height: bounds.height,
        }));
        popup_log!("[popup] restored bounds => {:?}", bounds);
        return;
    }

    // Center the popup when no saved position is available.
    let monitor_opt = win
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| win.available_monitors().ok()?.into_iter().next());

    if let Some(monitor) = monitor_opt {
        let scale = monitor.scale_factor();
        let screen_x = monitor.position().x as f64 / scale;
        let screen_y = monitor.position().y as f64 / scale;
        let screen_w = monitor.size().width as f64 / scale;
        let screen_h = monitor.size().height as f64 / scale;
        let win_size = win
            .outer_size()
            .map(|size| size.to_logical::<f64>(scale))
            .unwrap_or(tauri::LogicalSize {
                width: 700.0,
                height: 600.0,
            });
        let x = screen_x + (screen_w - win_size.width) * 0.5;
        let y = screen_y + (screen_h - win_size.height) * 0.5;
        popup_log!(
            "[popup] default position => x={x} y={y} screen=({screen_x},{screen_y},{screen_w},{screen_h}) scale={scale}"
        );
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));
    } else {
        popup_log!("[popup] WARNING: no monitor found, using fallback centered position");
        let _ = win.set_position(tauri::Position::Logical(tauri::LogicalPosition {
            x: 200.0,
            y: 120.0,
        }));
    }
}

// macOS window attributes

#[cfg(target_os = "macos")]
pub fn setup_popup_window(win: &tauri::WebviewWindow) {
    use cocoa::base::NO;
    use objc::{class, msg_send, sel, sel_impl};
    unsafe {
        let ns_window = win.ns_window().expect("ns_window") as cocoa::base::id;
        let _: () = msg_send![ns_window, setOpaque: NO];
        let clear: cocoa::base::id = msg_send![class!(NSColor), clearColor];
        let _: () = msg_send![ns_window, setBackgroundColor: clear];

        // Use the normal window level so the popup does not float above other applications.
        // NSNormalWindowLevel = 0
        let _: () = msg_send![ns_window, setLevel: 0_i64];

        // Keep the popup visible when another application becomes active.
        let _: () = msg_send![ns_window, setHidesOnDeactivate: NO];
    }
}

// Native macOS window animations
//
// Use NSAnimationContext and [[window animator] setFrame:display:]
// for native window resizing animations.
//
// Coordinate systems:
//   NSWindow/NSScreen use a bottom-left origin with the Y axis pointing upward.
//   Tauri logical coordinates use a top-left origin with the Y axis pointing downward.
//   Conversion: ns_y = screen_h - tauri_y - window_height.
//
// Thread safety:
//   NSAnimationContext must run on the main thread.
//   Pass the NSWindow pointer as usize into the 'static + Send run_on_main_thread closure.
//   Access the pointer only inside that closure, which runs on the main thread.

#[cfg(target_os = "macos")]
unsafe fn do_animated_set_frame(
    ns_window_ptr: usize,
    target_x: f64,
    target_y: f64,
    target_w: f64,
    target_h: f64,
    screen_h: f64,
    duration: f64,
) {
    use objc::{class, msg_send, sel, sel_impl};

    let ns_window = ns_window_ptr as cocoa::base::id;

    // NSRect has the same memory layout as CoreGraphics CGRect.
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSPoint {
        x: f64,
        y: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSSize {
        width: f64,
        height: f64,
    }
    #[repr(C)]
    #[derive(Clone, Copy)]
    struct NSRect {
        origin: NSPoint,
        size: NSSize,
    }

    // Convert Tauri's top-left, downward-Y coordinates to macOS's bottom-left, upward-Y coordinates.
    let ns_x = target_x;
    let ns_y = screen_h - target_y - target_h;

    // Step 1: read the current window frame.
    // Read the current width and height in macOS coordinates.
    let cur_frame: NSRect = msg_send![ns_window, frame];
    let cur_w = cur_frame.size.width;
    let cur_h = cur_frame.size.height;

    // Step 2: align the origin immediately, keeping the current size and suppressing redraw.
    //
    // NSAnimationContext interpolates both the frame's origin and its size.
    // Using the same origin at both endpoints keeps the origin fixed throughout the animation;
    // the window then appears to expand or contract in place.
    //
    // Sequence:
    //   1. Set the frame to (target_origin, current_size) with display:NO.
    //      The internal frame moves immediately while the screen retains its previous pixels.
    //   2. Animate the frame to (target_origin, target_size).
    //      Identical start and end origins keep the position fixed; only the size changes.
    //      The user sees a smooth resize without a visible jump.
    let pre_frame = NSRect {
        origin: NSPoint { x: ns_x, y: ns_y }, // Use the animation's target origin.
        size: NSSize {
            width: cur_w,
            height: cur_h,
        },
    };
    // display:NO changes the internal frame without drawing the intermediate position.
    let _: () = msg_send![ns_window, setFrame: pre_frame display: cocoa::base::NO];

    // Step 3: animate to the target size while preserving the origin.
    let target_frame = NSRect {
        origin: NSPoint { x: ns_x, y: ns_y },
        size: NSSize {
            width: target_w,
            height: target_h,
        },
    };

    let ctx_class = class!(NSAnimationContext);
    let _: () = msg_send![ctx_class, beginGrouping];
    let ctx: cocoa::base::id = msg_send![ctx_class, currentContext];
    let _: () = msg_send![ctx, setDuration: duration];

    let animator: cocoa::base::id = msg_send![ns_window, animator];
    let _: () = msg_send![animator, setFrame: target_frame display: cocoa::base::YES];

    let _: () = msg_send![ctx_class, endGrouping];

    popup_log!(
        "[popup] center-expand → tauri({target_x:.0},{target_y:.0}) \
         ns_origin=({ns_x:.0},{ns_y:.0}) size={target_w:.0}×{target_h:.0} \
         cur={cur_w:.0}×{cur_h:.0} dur={duration}"
    );
}

// Show, hide, and toggle the popup

pub fn show_popup(app: &tauri::AppHandle, win: &tauri::WebviewWindow) {
    // Positioning is unnecessary here.
    // Hiding the window preserves its location, so showing it can reuse that position.
    // position_popup is called only when create_popup initially creates the window.
    let _ = win.show();

    #[cfg(target_os = "macos")]
    unsafe {
        use cocoa::base::nil;
        use objc::{msg_send, sel, sel_impl};
        let ns_window = win.ns_window().expect("ns_window") as cocoa::base::id;
        let _: () = msg_send![ns_window, makeKeyAndOrderFront: nil];
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = win.set_focus();
    }

    app.state::<PopupVisible>().set(true);
    let _ = win.emit("popup-shown", ());
    popup_log!("[popup] shown");
}

pub fn toggle_popup(app: &tauri::AppHandle) {
    popup_log!("[popup] toggle_popup called");

    if let Some(win) = app.get_webview_window("popup") {
        let really_visible = win.is_visible().unwrap_or(false);
        let state_visible = app.state::<PopupVisible>().get();
        let is_visible = really_visible || state_visible;
        popup_log!(
            "[popup] window exists, really_visible={really_visible} state_visible={state_visible}"
        );

        if is_visible {
            popup_log!("[popup] hiding");
            app.state::<PopupVisible>().set(false);
            let _ = win.hide();
        } else {
            popup_log!("[popup] showing via show_popup_only");
            show_popup_only(app.clone());
        }
    } else {
        popup_log!("[popup] window not found, creating");
        create_popup(app);
    }
}

/// Show and focus the popup without emitting popup-focused or expanding a session.
pub fn show_popup_only(app: tauri::AppHandle) {
    if let Some(win) = app.get_webview_window("popup") {
        show_popup(&app, &win);
    } else {
        create_popup(&app);
    }
}

fn create_popup(app: &tauri::AppHandle) {
    let (default_w, default_h) = load_bounds(app)
        .map(|b| (b.width, b.height))
        .unwrap_or((700.0, 600.0));

    let win = WebviewWindowBuilder::new(app, "popup", WebviewUrl::App("index.html".into()))
        .title("")
        .inner_size(default_w, default_h)
        .decorations(false)
        .transparent(true)
        .always_on_top(false)
        .shadow(false)
        .resizable(true)
        .skip_taskbar(true)
        .visible(false)
        .build()
        .expect("Failed to create popup window");

    #[cfg(target_os = "macos")]
    setup_popup_window(&win);

    position_popup(app, &win);
    show_popup(app, &win);
}

// ── Tauri Commands ────────────────────────────────────────────────

#[tauri::command]
pub fn exit_app(app: tauri::AppHandle) {
    app.exit(0);
}

/// Hide the popup.
#[tauri::command]
pub fn close_popup(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    app.state::<PopupVisible>().set(false);
    let _ = window.hide();
}

#[derive(Clone, serde::Serialize)]
struct PopupFocusedPayload {
    session_id: Option<String>,
}

/// Shared entry point for showing and activating the popup.
///
/// Unlike toggle_popup and show_popup:
/// - Do not emit popup-shown, which causes the frontend to collapse the terminal.
/// - Emit popup-focused with the optional session_id.
/// - Bring the window to the foreground whether it was previously visible or hidden.
#[tauri::command]
pub fn focus_popup(app: tauri::AppHandle, session_id: Option<String>) {
    // Discard stale compact-window bounds before a notification click opens a session.
    app.state::<crate::state::PreExpandPos>().clear();

    if let Some(win) = app.get_webview_window("popup") {
        let _ = win.show();

        #[cfg(target_os = "macos")]
        unsafe {
            use cocoa::base::nil;
            use objc::{msg_send, sel, sel_impl};
            let ns_window = win.ns_window().expect("ns_window") as cocoa::base::id;
            let _: () = msg_send![ns_window, makeKeyAndOrderFront: nil];
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = win.set_focus();
        }

        app.state::<PopupVisible>().set(true);
        let _ = win.emit("popup-focused", PopupFocusedPayload { session_id });
        popup_log!("[popup] focused via notification click");
    } else {
        create_popup(&app);
        if let Some(win) = app.get_webview_window("popup") {
            let _ = win.emit("popup-focused", PopupFocusedPayload { session_id });
        }
    }
}

// Expanded window positioning
//
// Expand equally around the compact window's current center.
// If necessary, apply the smallest translation that keeps the expanded window on screen.
//
// The center remains fixed whenever screen space allows.
// The entire window shifts only when expansion would otherwise cross a screen edge.
//
// Collapse around the same center to restore the compact window.
// If the expanded window has not been moved, its center matches the original center.

/// Calculate the expanded window's top-left position from its current bounds and target size.
///
/// Arguments:
///   (orig_x, orig_y, orig_w, orig_h): compact window bounds in logical pixels.
///   (exp_w, exp_h): target expanded size.
///   (screen_x, screen_y, screen_w, screen_h): monitor work area in logical pixels.
///
/// Return (new_x, new_y), the expanded window's top-left coordinates.
fn calc_expand_pos(
    orig_x: f64,
    orig_y: f64,
    orig_w: f64,
    orig_h: f64,
    exp_w: f64,
    exp_h: f64,
    screen_x: f64,
    screen_y: f64,
    screen_w: f64,
    screen_h: f64,
) -> (f64, f64) {
    // Center of the compact window.
    let cx = orig_x + orig_w * 0.5;
    let cy = orig_y + orig_h * 0.5;

    // Ideal expansion keeps the larger window centered at the same point.
    let ideal_x = cx - exp_w * 0.5;
    let ideal_y = cy - exp_h * 0.5;

    // Usable screen bounds; reserve 28 pixels for the macOS menu bar.
    let safe_top = screen_y + 28.0;
    let safe_left = screen_x;
    let safe_right = screen_x + screen_w;
    let safe_bottom = screen_y + screen_h;

    // Apply the smallest correction needed to keep the window within screen bounds.
    let mut x = ideal_x;
    let mut y = ideal_y;

    // Right-edge overflow: shift left.
    if x + exp_w > safe_right {
        x = safe_right - exp_w;
    }
    // Left-edge overflow: shift right.
    if x < safe_left {
        x = safe_left;
    }
    // Bottom-edge overflow: shift up.
    if y + exp_h > safe_bottom {
        y = safe_bottom - exp_h;
    }
    // Top-edge or menu-bar overlap: shift down.
    if y < safe_top {
        y = safe_top;
    }

    popup_log!(
        "[popup] expand center=({cx:.0},{cy:.0}) ideal=({ideal_x:.0},{ideal_y:.0}) \
         clamped=({x:.0},{y:.0}) size={exp_w:.0}×{exp_h:.0}"
    );

    (x, y)
}

/// Share bounds-update logic between animated and immediate resizing.
fn apply_window_frame(
    window: &tauri::WebviewWindow,
    new_x: f64,
    new_y: f64,
    new_w: f64,
    new_h: f64,
    _screen_h: f64,
    _duration: f64,
) {
    // macOS: use native NSAnimationContext animation.
    #[cfg(target_os = "macos")]
    {
        let ns_window_ptr: usize = match window.ns_window() {
            Ok(ptr) => ptr as usize,
            Err(_) => {
                // Fall back to immediate resizing if the native window handle is unavailable.
                let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                    x: new_x,
                    y: new_y,
                }));
                let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
                    width: new_w,
                    height: new_h,
                }));
                return;
            }
        };
        let _ = window.run_on_main_thread(move || {
            unsafe {
                do_animated_set_frame(
                    ns_window_ptr,
                    new_x,
                    new_y,
                    new_w,
                    new_h,
                    _screen_h,
                    _duration,
                )
            };
        });
    }

    // Other platforms: update bounds immediately.
    #[cfg(not(target_os = "macos"))]
    {
        let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
            x: new_x,
            y: new_y,
        }));
        let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
            width: new_w,
            height: new_h,
        }));
    }
}

/// Expand the terminal panel.
///
/// Expand around the compact window's center whenever space permits.
/// Move the window only as much as needed to keep the expanded bounds on screen.
///
/// Use a 220 ms native ease animation on macOS and immediate resizing elsewhere.
/// Expansion is temporary; do not overwrite the saved compact-window bounds.
#[tauri::command]
pub fn resize_popup_full(
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
    width: f64,
    height: f64,
) {
    let scale = window.scale_factor().unwrap_or(1.0);

    // Current window position and size in logical pixels.
    let (orig_x, orig_y) = match window.outer_position() {
        Ok(p) => (p.x as f64 / scale, p.y as f64 / scale),
        Err(_) => {
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
            return;
        }
    };
    let (orig_w, orig_h) = window
        .outer_size()
        .map(|s| (s.width as f64 / scale, s.height as f64 / scale))
        .unwrap_or((700.0, 600.0));

    // Cache the compact window's exact bounds before expansion for later restoration.
    app.state::<crate::state::PreExpandPos>()
        .set(crate::state::Bounds4 {
            x: orig_x,
            y: orig_y,
            w: orig_w,
            h: orig_h,
        });

    // Read monitor information.
    let monitor_opt = window
        .current_monitor()
        .ok()
        .flatten()
        .or_else(|| window.primary_monitor().ok().flatten());
    let monitor = match monitor_opt {
        Some(m) => m,
        None => {
            // Without monitor information, expand in place without checking screen bounds.
            let cx = orig_x + orig_w * 0.5;
            let cy = orig_y + orig_h * 0.5;
            let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition {
                x: cx - width * 0.5,
                y: cy - height * 0.5,
            }));
            let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize { width, height }));
            return;
        }
    };
    let ms = monitor.scale_factor();
    let screen_x = monitor.position().x as f64 / ms;
    let screen_y = monitor.position().y as f64 / ms;
    let screen_w = monitor.size().width as f64 / ms;
    let screen_h = monitor.size().height as f64 / ms;

    let (new_x, new_y) = calc_expand_pos(
        orig_x, orig_y, orig_w, orig_h, width, height, screen_x, screen_y, screen_w, screen_h,
    );

    apply_window_frame(&window, new_x, new_y, width, height, screen_h, 0.18);
}

/// Restore the exact pre-expansion position and size after collapsing the terminal panel.
///
/// Resolution order:
///   1. PreExpandPos: the precise in-memory snapshot captured before expansion.
///   2. popup_bounds.json: disk fallback after a cold start or interrupted session.
///   3. Leave the current bounds unchanged when no saved position is available.
///
/// Apply position and size directly using set_position and set_size.
/// Avoid animation coordinate conversions during restoration.
/// Use RestoringLock so collapse-triggered resize events cannot overwrite saved bounds.
#[tauri::command]
pub fn restore_popup_bounds(app: tauri::AppHandle, window: tauri::WebviewWindow) {
    // Arm the 600 ms guard before frontend resize events can persist intermediate bounds.
    app.state::<crate::state::RestoringLock>().arm();

    // Resolve target bounds from memory first, then disk.
    let (x, y, w, h) = if let Some(snap) = app.state::<crate::state::PreExpandPos>().take() {
        // Use the exact pre-expansion snapshot when available.
        popup_log!(
            "[popup] restore: cache hit ({:.0},{:.0}) {:.0}×{:.0}",
            snap.x,
            snap.y,
            snap.w,
            snap.h
        );
        (snap.x, snap.y, snap.w, snap.h)
    } else if let Some(disk) = load_bounds(&app).filter(|b| is_on_screen(&window, b)) {
        // Fall back to saved disk bounds.
        popup_log!(
            "[popup] restore: disk fallback ({:.0},{:.0}) {:.0}×{:.0}",
            disk.x,
            disk.y,
            disk.width,
            disk.height
        );
        (disk.x, disk.y, disk.width, disk.height)
    } else {
        // No saved bounds are available on the first run.
        popup_log!("[popup] restore: using defaults");
        return; // Keep the current position when no saved bounds are available.
    };

    // Apply position and size directly.
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: w,
        height: h,
    }));
    let _ = window.set_position(tauri::Position::Logical(tauri::LogicalPosition { x, y }));

    popup_log!("[popup] restore done => ({x:.0},{y:.0}) {w:.0}×{h:.0}");
}

/// Legacy height-only resize: preserve width and position, then persist the bounds.
#[tauri::command]
pub fn resize_popup(app: tauri::AppHandle, window: tauri::WebviewWindow, height: f64) {
    let h = height.clamp(200.0, 1600.0);
    let scale = window.scale_factor().unwrap_or(1.0);
    let cur_size = window
        .inner_size()
        .map(|s| s.to_logical::<f64>(scale))
        .unwrap_or(tauri::LogicalSize {
            width: 700.0,
            height: h,
        });
    let w = cur_size.width.max(300.0);
    let _ = window.set_size(tauri::Size::Logical(tauri::LogicalSize {
        width: w,
        height: h,
    }));
    if let Ok(pos) = window.outer_position() {
        save_bounds_to_file(
            &app,
            &window,
            &PopupBounds {
                x: pos.x as f64 / scale,
                y: pos.y as f64 / scale,
                width: w,
                height: h,
            },
        );
    }
}

/// Open the platform's native folder selection dialog.
#[tauri::command]
pub fn pick_folder(app: tauri::AppHandle) -> String {
    let description = crate::i18n::interface_text(&app, "native.pickFolder", "");
    #[cfg(target_os = "macos")]
    {
        let script = r#"
            set folderPath to POSIX path of (choose folder with prompt "__FOLDER_DESCRIPTION__")
            return folderPath
        "#;
        let output = background_command("osascript")
            .arg("-e")
            .arg(script.replace("__FOLDER_DESCRIPTION__", &description))
            .output();
        return match output {
            Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
                .trim()
                .trim_end_matches('/')
                .to_string(),
            _ => String::new(),
        };
    }

    #[cfg(windows)]
    {
        let script = r#"
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = "__FOLDER_DESCRIPTION__"
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Write($dialog.SelectedPath)
}
"#;
        let output = background_command("powershell.exe")
            .args([
                "-NoProfile",
                "-STA",
                "-Command",
                &script.replace("__FOLDER_DESCRIPTION__", &description),
            ])
            .output();
        return match output {
            Ok(out) if out.status.success() => String::from_utf8_lossy(&out.stdout)
                .trim()
                .trim_end_matches(['\\', '/'])
                .to_string(),
            _ => String::new(),
        };
    }

    #[cfg(all(not(target_os = "macos"), not(windows)))]
    {
        String::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minimized_window_placeholder_is_never_restored() {
        // The frame Windows reported for the minimized popup at 200% scale.
        let minimized = PopupBounds {
            x: -16000.0,
            y: -16000.0,
            width: 144.0,
            height: 17.5,
        };
        assert!(!minimized.is_usable_size());
        let normal = PopupBounds {
            x: 120.0,
            y: 80.0,
            width: 700.0,
            height: 600.0,
        };
        assert!(normal.is_usable_size());
    }
}
