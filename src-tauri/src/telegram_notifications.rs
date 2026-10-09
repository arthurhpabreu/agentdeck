//! Optional completion alerts. Tokens never enter preferences, command results, or logs.
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::io::Read;
use std::path::Path;
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const CONFIG_FILE: &str = "telegram-notifications.json";
const CREDENTIAL_SERVICE: &str = "com.agentdeck.telegram-notifications";
const PAIRING_TTL: Duration = Duration::from_secs(600);
const MAX_PENDING: usize = 4;
const QUEUE_CAPACITY: usize = 16;
const RESPONSE_LIMIT: u64 = 512 * 1024;

fn error(key: &str) -> String {
    format!("telegram.errors.{key}")
}

#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct PersistedConfig {
    enabled: bool,
    credential_id: Option<String>,
    bot_username: Option<String>,
    chat_id: Option<i64>,
    chat_label: Option<String>,
}

impl PersistedConfig {
    fn configured(&self) -> bool {
        self.chat_id.is_some_and(|id| id > 0)
            && self.credential_id.as_ref().is_some_and(|id| !id.is_empty())
            && self
                .bot_username
                .as_ref()
                .is_some_and(|name| valid_username(name))
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramNotificationSettings {
    pub enabled: bool,
    pub configured: bool,
    pub bot_username: Option<String>,
    pub chat_label: Option<String>,
    pub last_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TelegramPairingInfo {
    pub pairing_id: String,
    pub url: String,
    pub bot_username: String,
}

// No Debug implementation: these objects temporarily contain a bot token.
#[derive(Clone)]
struct PendingPairing {
    token: String,
    nonce: String,
    bot_username: String,
    started_at: u64,
    expires: Instant,
    offset: Option<i64>,
}

impl PendingPairing {
    fn expired(&self, now: Instant) -> bool {
        now >= self.expires
    }
}

#[derive(Default)]
struct Inner {
    config: Option<PersistedConfig>,
    pending: HashMap<String, PendingPairing>,
    last_error: Option<String>,
    generation: u64,
}

struct QueuedCompletion {
    body: String,
    generation: u64,
}

pub struct TelegramState {
    inner: Mutex<Inner>,
    sender: Mutex<Option<mpsc::SyncSender<QueuedCompletion>>>,
    // Serialize test sends and completion sends to keep the bot below chat rate limits.
    send_gate: Mutex<Instant>,
}

impl Default for TelegramState {
    fn default() -> Self {
        Self {
            inner: Mutex::new(Inner::default()),
            sender: Mutex::new(None),
            send_gate: Mutex::new(Instant::now()),
        }
    }
}

fn config_path(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map(|directory| directory.join(CONFIG_FILE))
        .map_err(|_| error("storage"))
}

fn read_config(path: &Path) -> Result<PersistedConfig, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| error("storage")),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(PersistedConfig::default()),
        Err(_) => Err(error("storage")),
    }
}

fn write_config(path: &Path, config: &PersistedConfig) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| error("storage"))?;
    std::fs::create_dir_all(parent).map_err(|_| error("storage"))?;
    let bytes = serde_json::to_vec_pretty(config).map_err(|_| error("storage"))?;
    let temporary = parent.join(format!(".telegram-{}.tmp", uuid::Uuid::new_v4()));
    let result = std::fs::write(&temporary, bytes)
        .and_then(|()| std::fs::rename(&temporary, path))
        .map_err(|_| error("storage"));
    if result.is_err() {
        let _ = std::fs::remove_file(temporary);
    }
    result
}

fn ensure_loaded(inner: &mut Inner, app: &tauri::AppHandle) -> Result<(), String> {
    if inner.config.is_none() {
        inner.config = Some(read_config(&config_path(app)?)?);
    }
    Ok(())
}

fn settings(inner: &Inner) -> TelegramNotificationSettings {
    let config = inner.config.as_ref().cloned().unwrap_or_default();
    let configured = config.configured();
    TelegramNotificationSettings {
        enabled: configured && config.enabled,
        configured,
        bot_username: config.bot_username,
        chat_label: config.chat_label,
        last_error: inner.last_error.clone(),
    }
}

// Every secure-store call is serialized by `inner`; platform errors may contain
// credential details and are deliberately replaced with a stable error code.
fn credential(id: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, id).map_err(|_| error("secureStorage"))
}

fn read_token(config: &PersistedConfig) -> Result<String, String> {
    if !config.configured() {
        return Err(error("notConfigured"));
    }
    let token = credential(config.credential_id.as_deref().unwrap_or_default())?
        .get_password()
        .map_err(|_| error("secureStorage"))?;
    if !valid_token(&token) {
        return Err(error("invalidToken"));
    }
    Ok(token)
}

fn forget_credential(id: &str) -> Result<(), String> {
    match credential(id)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err(error("secureStorage")),
    }
}

fn valid_token(token: &str) -> bool {
    let Some((id, secret)) = token.split_once(':') else {
        return false;
    };
    !id.is_empty()
        && id.len() <= 20
        && id.bytes().all(|character| character.is_ascii_digit())
        && (20..=128).contains(&secret.len())
        && secret
            .bytes()
            .all(|character| character.is_ascii_alphanumeric() || b"_-".contains(&character))
}

fn valid_username(username: &str) -> bool {
    (5..=32).contains(&username.len())
        && username
            .bytes()
            .all(|character| character.is_ascii_alphanumeric() || character == b'_')
}

struct TelegramApi {
    client: reqwest::blocking::Client,
    base: String,
}

impl TelegramApi {
    fn new() -> Result<Self, String> {
        Ok(Self {
            client: reqwest::blocking::Client::builder()
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(10))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|_| error("network"))?,
            base: "https://api.telegram.org".into(),
        })
    }

    fn request(&self, token: &str, method: &str, form: &[(&str, String)]) -> Result<Value, String> {
        // Never format request/response errors: reqwest includes the token-bearing URL.
        let response = self
            .client
            .post(format!("{}/bot{token}/{method}", self.base))
            .form(form)
            .send()
            .map_err(|err| {
                error(if err.is_timeout() {
                    "timeout"
                } else {
                    "network"
                })
            })?;
        let status = response.status().as_u16();
        if response
            .content_length()
            .is_some_and(|size| size > RESPONSE_LIMIT)
        {
            return Err(error("responseTooLarge"));
        }
        let mut bytes = Vec::new();
        response
            .take(RESPONSE_LIMIT + 1)
            .read_to_end(&mut bytes)
            .map_err(|_| error("network"))?;
        if bytes.len() as u64 > RESPONSE_LIMIT {
            return Err(error("responseTooLarge"));
        }
        let value: Value = serde_json::from_slice(&bytes).map_err(|_| {
            if status >= 400 {
                api_error(status as u64)
            } else {
                error("invalidResponse")
            }
        })?;
        if !(200..300).contains(&status) || value["ok"] != true {
            return Err(api_error(
                value["error_code"].as_u64().unwrap_or(status as u64),
            ));
        }
        value
            .get("result")
            .cloned()
            .ok_or_else(|| error("invalidResponse"))
    }

    fn send(&self, token: &str, chat_id: i64, body: &str) -> Result<(), String> {
        self.request(
            token,
            "sendMessage",
            &[
                ("chat_id", chat_id.to_string()),
                ("text", body.chars().take(4096).collect()),
                ("disable_web_page_preview", "true".into()),
            ],
        )
        .map(|_| ())
    }
}

fn api_error(code: u64) -> String {
    error(match code {
        401 | 404 => "unauthorized",
        403 => "forbidden",
        409 => "conflict",
        429 => "rateLimited",
        _ => "api",
    })
}

fn now_seconds() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_secs())
}

fn select_chat(updates: &Value, pending: &PendingPairing, now: u64) -> Option<(i64, String)> {
    let command = format!("/start {}", pending.nonce);
    let addressed_command = format!("/start@{} {}", pending.bot_username, pending.nonce);
    updates.as_array()?.iter().find_map(|update| {
        let message = update.get("message")?;
        let text = message["text"].as_str()?.trim();
        let date = message["date"].as_u64()?;
        let chat = &message["chat"];
        let id = chat["id"].as_i64()?;
        if chat["type"] != "private"
            || id <= 0
            || message["from"]["is_bot"] != false
            || message["from"]["id"].as_i64() != Some(id)
            || date < pending.started_at
            || date > now.saturating_add(30)
            || now.saturating_sub(date) > PAIRING_TTL.as_secs()
            || (text != command && text != addressed_command)
        {
            return None;
        }
        let label = if let Some(username) = chat["username"]
            .as_str()
            .filter(|name| valid_username(name))
        {
            format!("@{username}")
        } else {
            chat["first_name"]
                .as_str()
                .unwrap_or("Telegram")
                .chars()
                .filter(|character| !character.is_control())
                .take(80)
                .collect()
        };
        Some((id, label))
    })
}

#[tauri::command]
pub fn get_telegram_notification_settings(
    app: tauri::AppHandle,
) -> Result<TelegramNotificationSettings, String> {
    let state = app.state::<TelegramState>();
    let mut inner = state.inner.lock().map_err(|_| error("internal"))?;
    ensure_loaded(&mut inner, &app)?;
    Ok(settings(&inner))
}

#[tauri::command]
pub async fn start_telegram_pairing(
    app: tauri::AppHandle,
    token: String,
) -> Result<TelegramPairingInfo, String> {
    tauri::async_runtime::spawn_blocking(move || start_pairing(&app, token))
        .await
        .map_err(|_| error("internal"))?
}

fn start_pairing(app: &tauri::AppHandle, token: String) -> Result<TelegramPairingInfo, String> {
    let state = app.state::<TelegramState>();
    let token = token.trim().to_owned();
    let token = if token.is_empty() {
        let mut inner = state.inner.lock().map_err(|_| error("internal"))?;
        ensure_loaded(&mut inner, app)?;
        read_token(
            inner
                .config
                .as_ref()
                .ok_or_else(|| error("notConfigured"))?,
        )?
    } else {
        token
    };
    if !valid_token(&token) {
        return Err(error("invalidToken"));
    }
    let api = TelegramApi::new()?;
    let me = api.request(&token, "getMe", &[])?;
    if me["is_bot"] != true {
        return Err(error("invalidResponse"));
    }
    let username = me["username"]
        .as_str()
        .filter(|name| valid_username(name))
        .ok_or_else(|| error("invalidResponse"))?
        .to_owned();
    let webhook = api.request(&token, "getWebhookInfo", &[])?;
    let webhook_url = webhook["url"]
        .as_str()
        .ok_or_else(|| error("invalidResponse"))?;
    if !webhook_url.is_empty() {
        // Never delete someone else's webhook to make pairing work.
        return Err(error("webhookConfigured"));
    }
    let mut inner = state.inner.lock().map_err(|_| error("internal"))?;
    let now = Instant::now();
    inner.pending.retain(|_, pending| !pending.expired(now));
    if inner.pending.len() >= MAX_PENDING {
        return Err(error("pairingBusy"));
    }
    // Settings has one pairing flow. A new valid link supersedes abandoned links,
    // so closing and reopening setup cannot exhaust the bounded pending slots.
    inner.pending.clear();
    let id = uuid::Uuid::new_v4().to_string();
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    inner.pending.insert(
        id.clone(),
        PendingPairing {
            token,
            nonce: nonce.clone(),
            bot_username: username.clone(),
            started_at: now_seconds(),
            expires: now + PAIRING_TTL,
            offset: None,
        },
    );
    Ok(TelegramPairingInfo {
        pairing_id: id,
        url: format!("https://t.me/{username}?start={nonce}"),
        bot_username: username,
    })
}

#[tauri::command]
pub async fn finish_telegram_pairing(
    app: tauri::AppHandle,
    pairing_id: String,
) -> Result<TelegramNotificationSettings, String> {
    tauri::async_runtime::spawn_blocking(move || finish_pairing(&app, &pairing_id))
        .await
        .map_err(|_| error("internal"))?
}

fn finish_pairing(
    app: &tauri::AppHandle,
    id: &str,
) -> Result<TelegramNotificationSettings, String> {
    let state = app.state::<TelegramState>();
    let pending = {
        let mut inner = state.inner.lock().map_err(|_| error("internal"))?;
        let pending = inner
            .pending
            .get(id)
            .ok_or_else(|| error("pairingExpired"))?;
        if pending.expired(Instant::now()) {
            inner.pending.remove(id);
            return Err(error("pairingExpired"));
        }
        pending.clone()
    };
    let api = TelegramApi::new()?;
    let mut form = vec![
        ("timeout", "0".into()),
        ("limit", "100".into()),
        ("allowed_updates", "[\"message\"]".into()),
    ];
    if let Some(offset) = pending.offset {
        form.push(("offset", offset.to_string()));
    }
    let updates = api.request(&pending.token, "getUpdates", &form)?;
    if !updates.is_array() {
        return Err(error("invalidResponse"));
    }
    let chat = select_chat(&updates, &pending, now_seconds());
    let mut inner = state.inner.lock().map_err(|_| error("internal"))?;
    if !inner
        .pending
        .get(id)
        .is_some_and(|pairing| !pairing.expired(Instant::now()))
    {
        inner.pending.remove(id);
        return Err(error("pairingExpired"));
    }
    let Some((chat_id, chat_label)) = chat else {
        // Advance through older updates without discarding arbitrary updates at start.
        // A dedicated personal bot is required so another consumer cannot consume pairing.
        let next_offset = updates
            .as_array()
            .and_then(|items| {
                items
                    .iter()
                    .filter_map(|update| update["update_id"].as_i64())
                    .max()
            })
            .map(|id| id.saturating_add(1));
        if let Some(pairing) = inner.pending.get_mut(id) {
            pairing.offset = next_offset.or(pairing.offset);
        }
        return Err(error("pairingNotFound"));
    };
    ensure_loaded(&mut inner, app)?;
    let previous = inner.config.as_ref().cloned().unwrap_or_default();
    let path = config_path(app)?;
    let credential_id = uuid::Uuid::new_v4().to_string();
    if credential(&credential_id)?
        .set_password(&pending.token)
        .is_err()
    {
        let _ = forget_credential(&credential_id);
        return Err(error("secureStorage"));
    }
    let config = PersistedConfig {
        enabled: previous.enabled,
        credential_id: Some(credential_id.clone()),
        bot_username: Some(pending.bot_username),
        chat_id: Some(chat_id),
        chat_label: Some(chat_label),
    };
    if let Err(err) = write_config(&path, &config) {
        let _ = forget_credential(&credential_id);
        return Err(err);
    }
    inner.config = Some(config);
    inner.pending.clear();
    inner.generation = inner.generation.wrapping_add(1);
    inner.last_error = None;
    if let Some(old_id) = previous.credential_id {
        let _ = forget_credential(&old_id);
    }
    Ok(settings(&inner))
}

#[tauri::command]
pub fn set_telegram_notifications_enabled(
    app: tauri::AppHandle,
    enabled: bool,
) -> Result<TelegramNotificationSettings, String> {
    let state = app.state::<TelegramState>();
    let mut inner = state.inner.lock().map_err(|_| error("internal"))?;
    ensure_loaded(&mut inner, &app)?;
    let mut config = inner.config.as_ref().cloned().unwrap_or_default();
    if enabled {
        let _ = read_token(&config)?;
    }
    config.enabled = enabled;
    write_config(&config_path(&app)?, &config)?;
    inner.config = Some(config);
    inner.generation = inner.generation.wrapping_add(1);
    inner.last_error = None;
    Ok(settings(&inner))
}

#[tauri::command]
pub fn disconnect_telegram_notifications(
    app: tauri::AppHandle,
) -> Result<TelegramNotificationSettings, String> {
    let state = app.state::<TelegramState>();
    let mut inner = state.inner.lock().map_err(|_| error("internal"))?;
    ensure_loaded(&mut inner, &app)?;
    let path = config_path(&app)?;
    disconnect_config(
        &mut inner,
        |config| write_config(&path, config),
        forget_credential,
    )
}

fn disconnect_config(
    inner: &mut Inner,
    mut save: impl FnMut(&PersistedConfig) -> Result<(), String>,
    mut erase: impl FnMut(&str) -> Result<(), String>,
) -> Result<TelegramNotificationSettings, String> {
    let mut previous = inner.config.as_ref().cloned().unwrap_or_default();
    previous.enabled = false;
    save(&previous)?;
    let credential_id = previous.credential_id.clone();
    inner.config = Some(previous);
    inner.pending.clear();
    inner.generation = inner.generation.wrapping_add(1);
    if let Some(id) = credential_id {
        if let Err(err) = erase(&id) {
            // Retain the reference while disabled, so another disconnect can retry
            // secure-store cleanup rather than silently orphaning the secret.
            inner.last_error = Some(err);
            return Ok(settings(inner));
        }
    }
    let config = PersistedConfig::default();
    if let Err(err) = save(&config) {
        inner.last_error = Some(err);
        return Ok(settings(inner));
    }
    inner.config = Some(config);
    inner.last_error = None;
    Ok(settings(inner))
}

#[tauri::command]
pub async fn send_telegram_test(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let locale = crate::i18n::current_locale(&app.state::<crate::i18n::LocaleState>());
        let text = match locale {
            crate::i18n::AppLocale::PtBr => {
                "Agentdeck: notificações do Telegram configuradas com sucesso."
            }
            crate::i18n::AppLocale::EsEs => {
                "Agentdeck: notificaciones de Telegram configuradas correctamente."
            }
            crate::i18n::AppLocale::EnUs => {
                "Agentdeck: Telegram notifications configured successfully."
            }
        };
        send_for_app(&app, text, None)
    })
    .await
    .map_err(|_| error("internal"))?
}

fn send_for_app(app: &tauri::AppHandle, text: &str, generation: Option<u64>) -> Result<(), String> {
    let state = app.state::<TelegramState>();
    let mut next_send = state.send_gate.lock().map_err(|_| error("internal"))?;
    let wait = next_send.saturating_duration_since(Instant::now());
    if !wait.is_zero() {
        std::thread::sleep(wait);
    }
    let destination = (|| -> Result<Option<(String, i64)>, String> {
        let mut inner = state.inner.lock().map_err(|_| error("internal"))?;
        ensure_loaded(&mut inner, app)?;
        let config = inner
            .config
            .as_ref()
            .ok_or_else(|| error("notConfigured"))?;
        if let Some(generation) = generation {
            if generation != inner.generation
                || !config.enabled
                || !crate::integration_control::notifications_and_hooks_enabled(app)
            {
                return Ok(None);
            }
        }
        Ok(Some((
            read_token(config)?,
            config.chat_id.ok_or_else(|| error("notConfigured"))?,
        )))
    })();
    let result = match destination {
        Ok(None) => return Ok(()),
        Ok(Some((token, chat_id))) => {
            TelegramApi::new().and_then(|api| api.send(&token, chat_id, text))
        }
        Err(err) => Err(err),
    };
    // No retry: after a timeout, Telegram may already have delivered the alert.
    let cooldown = if result
        .as_ref()
        .err()
        .is_some_and(|err| err == &error("rateLimited"))
    {
        Duration::from_secs(60)
    } else {
        Duration::from_secs(1)
    };
    *next_send = Instant::now() + cooldown;
    if let Ok(mut inner) = state.inner.lock() {
        if generation.is_none_or(|generation| generation == inner.generation) {
            inner.last_error = result.as_ref().err().cloned();
        }
    }
    result
}

/// The provider completion registry deduplicates before reaching this function.
/// Queueing cannot wait for the network or the credential store.
pub(crate) fn dispatch_completion(app: &tauri::AppHandle, body: &str) {
    if !crate::integration_control::notifications_and_hooks_enabled(app) {
        return;
    }
    let app = app.clone();
    let body = format!("Agentdeck: {body}");
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<TelegramState>();
        let generation = {
            let Ok(mut inner) = state.inner.lock() else {
                return;
            };
            if ensure_loaded(&mut inner, &app).is_err()
                || !inner
                    .config
                    .as_ref()
                    .is_some_and(|config| config.enabled && config.configured())
            {
                return;
            }
            inner.generation
        };
        let Ok(mut sender) = state.sender.lock() else {
            return;
        };
        if sender.is_none() {
            let (tx, rx) = mpsc::sync_channel::<QueuedCompletion>(QUEUE_CAPACITY);
            let worker_app = app.clone();
            if std::thread::Builder::new()
                .name("telegram-notifications".into())
                .spawn(move || {
                    while let Ok(completion) = rx.recv() {
                        let _ = send_for_app(
                            &worker_app,
                            &completion.body,
                            Some(completion.generation),
                        );
                    }
                })
                .is_err()
            {
                return;
            }
            *sender = Some(tx);
        }
        if let Some(sender) = sender.as_ref() {
            // A full queue drops excess alerts instead of growing an unbounded backlog.
            let _ = sender.try_send(QueuedCompletion { body, generation });
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn pending() -> PendingPairing {
        PendingPairing {
            token: "123456:abcdefghijklmnopqrstuvwxyz123456789".into(),
            nonce: "unique_nonce".into(),
            bot_username: "agentdeck_bot".into(),
            started_at: 1_000,
            expires: Instant::now() + PAIRING_TTL,
            offset: None,
        }
    }

    fn update(kind: &str, text: &str, date: u64, chat: i64) -> Value {
        json!({"update_id": 1, "message": {"text": text, "date": date,
            "from": {"id": chat, "is_bot": false},
            "chat": {"id": chat, "type": kind, "username": "arthur"}}})
    }

    #[test]
    fn pairing_requires_recent_exact_nonce_and_private_human_chat() {
        let updates = json!([
            update("private", "/start", 1_001, 1),
            update("group", "/start unique_nonce", 1_001, -2),
            update("private", "/start other_nonce", 1_001, 3),
            update("private", "/start unique_nonce extra", 1_001, 4),
            update("private", "/start unique_nonce", 999, 5),
            update("private", "/start unique_nonce", 1_101, 6),
            update("private", "/start unique_nonce", 1_001, 7),
        ]);
        assert_eq!(
            select_chat(&updates, &pending(), 1_002),
            Some((7, "@arthur".into()))
        );
        assert!(select_chat(&updates, &pending(), 1_800).is_none());
        let mut bot = update("private", "/start unique_nonce", 1_001, 7);
        bot["message"]["from"]["is_bot"] = json!(true);
        assert!(select_chat(&json!([bot]), &pending(), 1_002).is_none());
    }

    #[test]
    fn addressed_start_and_expiration_are_supported() {
        let pending = pending();
        assert!(select_chat(
            &json!([update(
                "private",
                "/start@agentdeck_bot unique_nonce",
                1_001,
                42
            )]),
            &pending,
            1_002
        )
        .is_some());
        assert!(!pending.expired(pending.expires - Duration::from_secs(1)));
        assert!(pending.expired(pending.expires));
    }

    #[test]
    fn config_defaults_off_and_never_serializes_token() {
        let config: PersistedConfig = serde_json::from_str("{}").unwrap();
        assert!(!config.enabled);
        assert!(!config.configured());
        let json = serde_json::to_string(&config).unwrap();
        assert!(!json.contains("token"));
        let inner = Inner {
            config: Some(config),
            ..Inner::default()
        };
        assert!(!settings(&inner).enabled);
        assert!(!settings(&inner).configured);
    }

    #[test]
    fn disconnect_failure_disables_sending_and_keeps_credential_for_retry() {
        let config = PersistedConfig {
            enabled: true,
            credential_id: Some("secure-token-entry".into()),
            bot_username: Some("agentdeck_bot".into()),
            chat_id: Some(42),
            chat_label: Some("Arthur".into()),
        };
        let mut inner = Inner {
            config: Some(config),
            ..Inner::default()
        };
        inner.pending.insert("old-pairing".into(), pending());
        let mut saved = Vec::new();
        let result = disconnect_config(
            &mut inner,
            |config| {
                saved.push(config.clone());
                Ok(())
            },
            |_| Err(error("secureStorage")),
        )
        .unwrap();
        assert!(!result.enabled);
        assert!(result.configured);
        assert_eq!(result.last_error, Some(error("secureStorage")));
        assert_eq!(saved.len(), 1);
        assert_eq!(
            saved[0].credential_id.as_deref(),
            Some("secure-token-entry")
        );
        assert!(inner.pending.is_empty());
        assert_eq!(inner.generation, 1);

        let mut erased = Vec::new();
        let result = disconnect_config(
            &mut inner,
            |_| Ok(()),
            |id| {
                erased.push(id.to_owned());
                Ok(())
            },
        )
        .unwrap();
        assert!(!result.configured);
        assert!(result.last_error.is_none());
        assert_eq!(erased, vec!["secure-token-entry"]);
        assert_eq!(inner.generation, 2);
    }

    #[test]
    fn disconnect_storage_failure_never_deletes_live_credential() {
        let mut inner = Inner {
            config: Some(PersistedConfig {
                enabled: true,
                credential_id: Some("secure-token-entry".into()),
                bot_username: Some("agentdeck_bot".into()),
                chat_id: Some(42),
                chat_label: None,
            }),
            ..Inner::default()
        };
        let mut erased = false;
        let result = disconnect_config(
            &mut inner,
            |_| Err(error("storage")),
            |_| {
                erased = true;
                Ok(())
            },
        );
        assert_eq!(result.err().unwrap(), error("storage"));
        assert!(!erased);
        assert!(settings(&inner).enabled);
    }

    #[test]
    fn config_survives_replacement_and_corruption_fails_closed() {
        let directory =
            std::env::temp_dir().join(format!("agentdeck-telegram-test-{}", uuid::Uuid::new_v4()));
        let path = directory.join(CONFIG_FILE);
        assert!(!read_config(&path).unwrap().enabled);
        write_config(&path, &PersistedConfig::default()).unwrap();
        let configured = PersistedConfig {
            enabled: true,
            credential_id: Some("id".into()),
            bot_username: Some("agentdeck_bot".into()),
            chat_id: Some(42),
            chat_label: Some("Arthur".into()),
        };
        write_config(&path, &configured).unwrap();
        assert!(read_config(&path).unwrap().configured());
        std::fs::write(&path, b"not json").unwrap();
        assert_eq!(read_config(&path).err().unwrap(), error("storage"));
        std::fs::remove_file(&path).unwrap();
        std::fs::remove_dir(&directory).unwrap();
    }

    fn server(response: String) -> (String, std::thread::JoinHandle<String>) {
        use std::io::Write;
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let worker = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .unwrap();
            let mut request = Vec::new();
            let mut buffer = [0; 4096];
            loop {
                let count = stream.read(&mut buffer).unwrap();
                if count == 0 {
                    break;
                }
                request.extend_from_slice(&buffer[..count]);
                if let Some(header_end) =
                    request.windows(4).position(|window| window == b"\r\n\r\n")
                {
                    let header = String::from_utf8_lossy(&request[..header_end]);
                    let size: usize = header
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .map(|value| value.trim().parse().unwrap())
                        })
                        .unwrap_or(0);
                    if request.len() >= header_end + 4 + size {
                        break;
                    }
                }
            }
            stream.write_all(response.as_bytes()).unwrap();
            String::from_utf8(request).unwrap()
        });
        (url, worker)
    }

    #[test]
    fn api_sends_encoded_forms_without_markdown_and_redacts_server_errors() {
        let token = pending().token;
        let body = r#"{"ok":true,"result":{"message_id":1}}"#;
        let (base, worker) = server(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ));
        let mut api = TelegramApi::new().unwrap();
        api.base = base;
        api.send(&token, 42, "Agentdeck: Olá & pronto?").unwrap();
        let request = worker.join().unwrap();
        assert!(request.contains("POST /bot123456:abcdefghijklmnopqrstuvwxyz123456789/sendMessage"));
        assert!(request
            .to_lowercase()
            .contains("application/x-www-form-urlencoded"));
        assert!(request.contains("chat_id=42"));
        assert!(request.contains("text=Agentdeck%3A+Ol%C3%A1+%26+pronto%3F"));
        assert!(!request.contains("parse_mode"));

        let body = format!(r#"{{"ok":false,"error_code":401,"description":"secret {token}"}}"#);
        let (base, worker) = server(format!(
            "HTTP/1.1 401 Unauthorized\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        ));
        api.base = base;
        let err = api.request(&token, "getMe", &[]).unwrap_err();
        worker.join().unwrap();
        assert_eq!(err, error("unauthorized"));
        assert!(!err.contains(&token));
    }

    #[test]
    fn api_limits_response_and_hides_transport_urls() {
        let token = pending().token;
        let (base, worker) = server(format!(
            "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            RESPONSE_LIMIT + 1
        ));
        let mut api = TelegramApi::new().unwrap();
        api.base = base;
        assert_eq!(
            api.request(&token, "getMe", &[]).unwrap_err(),
            error("responseTooLarge")
        );
        worker.join().unwrap();
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        api.base = format!("http://{}", listener.local_addr().unwrap());
        drop(listener);
        let err = api.request(&token, "getMe", &[]).unwrap_err();
        assert_eq!(err, error("network"));
        assert!(!err.contains(&token));
    }

    #[test]
    fn token_validation_prevents_path_and_query_injection() {
        assert!(valid_token(&pending().token));
        assert!(!valid_token("123:abcdefghijklmnopqrstuvwxyz/other"));
        assert!(!valid_token("123:abcdefghijklmnopqrstuvwxyz?other"));
        assert!(!valid_token("123:short"));
        assert!(!valid_username("agentdeck_bot/other"));
    }
}
