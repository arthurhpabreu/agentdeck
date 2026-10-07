use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

use notify::RecommendedWatcher;

// Child process registry
pub type ProcessMap = Arc<Mutex<HashMap<String, std::process::Child>>>;

// PTY registries
/// session_id → PTY master writer
pub type PtyWriterMap = Arc<Mutex<HashMap<String, Box<dyn Write + Send>>>>;
/// session_id to PTY child process handle for kill/wait operations.
pub struct PtyChildHandle {
    pub killer: Box<dyn portable_pty::ChildKiller + Send + Sync>,
    pub pid: Option<u32>,
    pub run_id: u64,
}
pub type PtyKillerMap = Arc<Mutex<HashMap<String, PtyChildHandle>>>;
/// session_id to MasterPty for resize operations.
pub type PtyMasterMap = Arc<Mutex<HashMap<String, Box<dyn portable_pty::MasterPty + Send>>>>;

#[derive(Debug, Clone, Default)]
pub struct PtySessionMeta {
    pub runner_type: String,
    pub workdir: String,
    pub project_path: String,
}

/// session_id to PTY metadata for routing hook events to the correct session.
pub type PtySessionMetaMap = Arc<Mutex<HashMap<String, PtySessionMeta>>>;

/// session_id to Git watcher for automatic source-control refresh.
pub type GitWatcherMap = Arc<Mutex<HashMap<String, RecommendedWatcher>>>;

// Pre-expansion window bounds, cached in memory for fast restoration.
/// Capture the compact window's exact bounds before expanding the terminal panel.
/// Prefer this snapshot when collapsing so stale disk values do not shift the window.
/// Reading the snapshot consumes it.
#[derive(Debug, Clone, Copy)]
pub struct Bounds4 {
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

pub struct PreExpandPos(Mutex<Option<Bounds4>>);

impl PreExpandPos {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    pub fn set(&self, b: Bounds4) {
        *self.0.lock().unwrap() = Some(b);
    }

    pub fn clear(&self) {
        *self.0.lock().unwrap() = None;
    }

    /// Take and clear the snapshot.
    pub fn take(&self) -> Option<Bounds4> {
        self.0.lock().unwrap().take()
    }
}

// Collapse guard: prevent animation resize events from overwriting saved bounds.
/// Record the time when restore_popup_bounds begins.
/// save_popup_bounds skips writes during the following 600 ms.
pub struct RestoringLock(Mutex<Option<Instant>>);

impl RestoringLock {
    pub fn new() -> Self {
        Self(Mutex::new(None))
    }

    /// Start a 600 ms guard covering the 100 ms collapse animation and 500 ms frontend debounce.
    pub fn arm(&self) {
        *self.0.lock().unwrap() = Some(Instant::now());
    }

    /// Return whether the guard is still active.
    pub fn is_locked(&self) -> bool {
        self.0
            .lock()
            .unwrap()
            .map(|t| t.elapsed() < Duration::from_millis(600))
            .unwrap_or(false)
    }
}

// Popup visibility state
pub struct PopupVisible(Mutex<bool>);

impl PopupVisible {
    pub fn new(v: bool) -> Self {
        Self(Mutex::new(v))
    }

    pub fn get(&self) -> bool {
        *self.0.lock().unwrap()
    }

    pub fn set(&self, v: bool) {
        *self.0.lock().unwrap() = v;
    }
}

pub struct TrayQuitItem(pub tauri::menu::MenuItem<tauri::Wry>);
