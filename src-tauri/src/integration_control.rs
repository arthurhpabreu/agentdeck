use std::path::PathBuf;

use serde::{Deserialize, Serialize};
use tauri::Manager;

const PREFERENCES_FILE: &str = "integration-preferences.json";

#[derive(Debug, Clone, Copy, Serialize, Deserialize)]
pub struct IntegrationPreferences {
    pub notifications_and_hooks_enabled: bool,
}

impl Default for IntegrationPreferences {
    fn default() -> Self {
        Self {
            notifications_and_hooks_enabled: true,
        }
    }
}

fn preferences_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|dir| dir.join(PREFERENCES_FILE))
        .map_err(|e| crate::i18n::native_text("native.parse", &format!("{e}")))
}

pub fn load_preferences(app: &tauri::AppHandle) -> IntegrationPreferences {
    let Ok(path) = preferences_path(app) else {
        return IntegrationPreferences::default();
    };

    let Ok(content) = std::fs::read_to_string(path) else {
        return IntegrationPreferences::default();
    };

    serde_json::from_str(&content).unwrap_or_default()
}

pub fn save_preferences(app: &tauri::AppHandle, enabled: bool) -> Result<(), String> {
    let path = preferences_path(app)?;
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).map_err(|e| {
            crate::i18n::native_text("native.create", &format!("{} : {e}", parent.display()))
        })?;
    }

    let content = serde_json::to_string_pretty(&IntegrationPreferences {
        notifications_and_hooks_enabled: enabled,
    })
    .map_err(|e| crate::i18n::native_text("native.serialize", &format!("{e}")))?;

    std::fs::write(&path, content)
        .map_err(|e| crate::i18n::native_text("native.write", &format!("{} : {e}", path.display())))
}

pub fn notifications_and_hooks_enabled(app: &tauri::AppHandle) -> bool {
    load_preferences(app).notifications_and_hooks_enabled
}
