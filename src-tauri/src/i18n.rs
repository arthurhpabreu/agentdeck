use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use tauri::Manager;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum AppLocale {
    EnUs,
    PtBr,
    EsEs,
}

impl Default for AppLocale {
    fn default() -> Self {
        Self::EnUs
    }
}
impl AppLocale {
    pub fn parse(value: &str) -> Self {
        let value = value.trim().to_ascii_lowercase();
        if value.starts_with("pt") {
            Self::PtBr
        } else if value.starts_with("es") {
            Self::EsEs
        } else {
            Self::EnUs
        }
    }
}

#[derive(Default)]
pub struct LocaleState;
static NATIVE_LOCALE: Mutex<AppLocale> = Mutex::new(AppLocale::EnUs);
pub fn current_locale(_state: &tauri::State<'_, LocaleState>) -> AppLocale {
    *NATIVE_LOCALE.lock().unwrap()
}

/// Native dialogs and terminal errors share the interface translation catalogue.
pub fn interface_text(_app: &tauri::AppHandle, key: &str, error: &str) -> String {
    native_text(key, error)
}

pub fn native_text(key: &str, error: &str) -> String {
    use std::sync::OnceLock;
    static CATALOGUES: OnceLock<[serde_json::Value; 3]> = OnceLock::new();
    let catalogues = CATALOGUES.get_or_init(|| {
        [
            serde_json::from_str(include_str!("../../src/i18n/locales/en-US.json"))
                .expect("valid English catalogue"),
            serde_json::from_str(include_str!("../../src/i18n/locales/pt-BR.json"))
                .expect("valid Portuguese catalogue"),
            serde_json::from_str(include_str!("../../src/i18n/locales/es-ES.json"))
                .expect("valid Spanish catalogue"),
        ]
    });
    let index = match *NATIVE_LOCALE.lock().unwrap() {
        AppLocale::EnUs => 0,
        AppLocale::PtBr => 1,
        AppLocale::EsEs => 2,
    };
    catalogues[index]
        .get(key)
        .and_then(|value| value.as_str())
        .unwrap_or(key)
        .replace("{{error}}", error)
}

pub fn translate(locale: AppLocale, key: &str, vars: &[(&str, &str)]) -> String {
    let template = match (locale, key) {
        (_, "notifications.hook_enabled") => match locale {
            AppLocale::EnUs => "Notifications and hooks are enabled\n{{detail}}",
            AppLocale::PtBr => "Notificações e hooks estão ativados\n{{detail}}",
            AppLocale::EsEs => "Las notificaciones y los hooks están activados\n{{detail}}",
        },
        (_, "notifications.hook_disabled") => match locale {
            AppLocale::EnUs => "Notifications and hooks are disabled\n{{detail}}",
            AppLocale::PtBr => "Notificações e hooks estão desativados\n{{detail}}",
            AppLocale::EsEs => "Las notificaciones y los hooks están desactivados\n{{detail}}",
        },
        (_, "notifications.claude_listener_not_ready") => match locale {
            AppLocale::EnUs => "Claude Code hook listener is not ready",
            AppLocale::PtBr => "O listener de hooks do Claude Code não está pronto",
            AppLocale::EsEs => "El listener de hooks de Claude Code no está listo",
        },
        (_, "notifications.claude_hooks_not_configured") => match locale {
            AppLocale::EnUs => "Claude Code hooks are not fully configured",
            AppLocale::PtBr => "Os hooks do Claude Code não estão totalmente configurados",
            AppLocale::EsEs => "Los hooks de Claude Code no están configurados por completo",
        },
        (_, "notifications.codex_feature_disabled") => match locale {
            AppLocale::EnUs => "Codex hook feature is not enabled",
            AppLocale::PtBr => "O recurso de hooks do Codex não está ativado",
            AppLocale::EsEs => "La función de hooks de Codex no está activada",
        },
        (_, "notifications.codex_hooks_not_configured") => match locale {
            AppLocale::EnUs => "Codex hooks are not fully configured",
            AppLocale::PtBr => "Os hooks do Codex não estão totalmente configurados",
            AppLocale::EsEs => "Los hooks de Codex no están configurados por completo",
        },
        (_, "notifications.codex_listener_not_ready") => match locale {
            AppLocale::EnUs => "Codex hook listener is not ready",
            AppLocale::PtBr => "O listener de hooks do Codex não está pronto",
            AppLocale::EsEs => "El listener de hooks de Codex no está listo",
        },
        (_, "notifications.codex_turn_complete") => match locale {
            AppLocale::EnUs => "Codex finished the current turn",
            AppLocale::PtBr => "O Codex concluiu esta etapa",
            AppLocale::EsEs => "Codex terminó este turno",
        },
        (_, "notifications.codex_generic") => match locale {
            AppLocale::EnUs => "Codex notification: {{type}}",
            AppLocale::PtBr => "Notificação do Codex: {{type}}",
            AppLocale::EsEs => "Notificación de Codex: {{type}}",
        },
        (_, "notifications.send_failed") => match locale {
            AppLocale::EnUs => "Failed to send notification: {{error}}",
            AppLocale::PtBr => "Falha ao enviar notificação: {{error}}",
            AppLocale::EsEs => "No se pudo enviar la notificación: {{error}}",
        },
        (_, "notifications.session_not_found") => match locale {
            AppLocale::EnUs => "No matching Agentdeck session found",
            AppLocale::PtBr => "Nenhuma sessão correspondente do Agentdeck foi encontrada",
            AppLocale::EsEs => "No se encontró una sesión de Agentdeck coincidente",
        },
        (_, "notifications.unknown_error") => match locale {
            AppLocale::EnUs => "Unknown error",
            AppLocale::PtBr => "Erro desconhecido",
            AppLocale::EsEs => "Error desconocido",
        },
        _ => key,
    };
    vars.iter()
        .fold(template.to_string(), |acc, (name, value)| {
            acc.replace(&format!("{{{{{name}}}}}"), value)
        })
}

#[tauri::command]
pub fn set_app_locale(
    app: tauri::AppHandle,
    locale: String,
    _state: tauri::State<'_, LocaleState>,
) {
    let locale = AppLocale::parse(&locale);
    *NATIVE_LOCALE.lock().unwrap() = locale;
    if let Some(item) = app.try_state::<crate::state::TrayQuitItem>() {
        let _ = item.0.set_text(match locale {
            AppLocale::EnUs => "Quit Agentdeck",
            AppLocale::PtBr => "Sair do Agentdeck",
            AppLocale::EsEs => "Salir de Agentdeck",
        });
    }
}
