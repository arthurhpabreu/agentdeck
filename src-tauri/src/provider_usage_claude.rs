//! Read-only Claude subscription usage. The endpoint is fixed and redirects are
//! disabled so the local OAuth token cannot be forwarded to another host.
use super::{unix_seconds, valid_percent, ProviderUsage, UsageWindow};
use serde_json::Value;
use std::{
    collections::hash_map::DefaultHasher,
    fs::File,
    hash::{Hash, Hasher},
    io::Read,
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime},
};

const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";
const SOURCE: &str = "claude-oauth";
const MAX_BYTES: u64 = 64 * 1024;
const CACHE_SECONDS: u64 = 300;
const MANUAL_COOLDOWN: u64 = 60;

// This structure deliberately has no Debug/Serialize implementations.
struct Login {
    token: String,
    identity: u64,
}

#[derive(Clone, Copy, Debug)]
struct Failure {
    reason: &'static str,
    retry_after: Option<u64>,
}
impl Failure {
    fn new(reason: &'static str) -> Self {
        Self {
            reason,
            retry_after: None,
        }
    }
}

fn credentials_path() -> Option<PathBuf> {
    std::env::var_os("CLAUDE_CONFIG_DIR")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(|| crate::util::home_dir().map(|path| path.join(".claude")))
        .map(|path| path.join(".credentials.json"))
}

fn parse_login(data: &[u8], path: &Path, now: u64) -> Result<Login, Failure> {
    let data = data.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(data);
    let value: Value = serde_json::from_slice(data).map_err(|_| Failure::new("read-error"))?;
    let oauth = value
        .get("claudeAiOauth")
        .ok_or(Failure::new("unsupported"))?;
    let token = oauth["accessToken"]
        .as_str()
        .filter(|token| !token.trim().is_empty())
        .ok_or(Failure::new("missing-login"))?;
    if let Some(expiry) = oauth.get("expiresAt").filter(|value| !value.is_null()) {
        let expiry_ms = expiry.as_u64().ok_or(Failure::new("read-error"))?;
        if expiry_ms / 1000 <= now {
            return Err(Failure::new("expired-login"));
        }
    }
    login_from_token(token, path)
}

fn login_from_token(token: &str, path: &Path) -> Result<Login, Failure> {
    // Avoid malformed authorization headers, including environment overrides.
    if token.trim().is_empty() {
        return Err(Failure::new("missing-login"));
    }
    if token.len() > 16 * 1024
        || !token.is_ascii()
        || token
            .bytes()
            .any(|byte| byte.is_ascii_control() || byte.is_ascii_whitespace())
    {
        return Err(Failure::new("read-error"));
    }
    let mut identity = DefaultHasher::new();
    path.hash(&mut identity);
    token.hash(&mut identity);
    Ok(Login {
        token: token.to_owned(),
        identity: identity.finish(),
    })
}

fn read_login(now: u64) -> Result<Login, Failure> {
    // The CLI gives its explicit OAuth environment token precedence over the
    // credentials file. Honor the same identity without changing either one.
    if let Some(token) =
        std::env::var_os("CLAUDE_CODE_OAUTH_TOKEN").filter(|value| !value.is_empty())
    {
        let token = token
            .into_string()
            .map_err(|_| Failure::new("read-error"))?;
        return login_from_token(&token, Path::new("environment:CLAUDE_CODE_OAUTH_TOKEN"));
    }
    let path = credentials_path().ok_or(Failure::new("missing-login"))?;
    let file = File::open(&path).map_err(|error| {
        Failure::new(if error.kind() == std::io::ErrorKind::NotFound {
            "missing-login"
        } else {
            "read-error"
        })
    })?;
    let mut bytes = Vec::new();
    file.take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::new("read-error"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(Failure::new("read-error"));
    }
    parse_login(&bytes, &path, now)
}

fn reset_timestamp(value: Option<&Value>) -> Option<u64> {
    let value = value?;
    if let Some(seconds) = value.as_u64() {
        return Some(seconds);
    }
    let parsed = time::OffsetDateTime::parse(
        value.as_str()?,
        &time::format_description::well_known::Rfc3339,
    )
    .ok()?;
    u64::try_from(parsed.unix_timestamp()).ok()
}

fn snapshot(value: &Value, observed_at: u64) -> Result<ProviderUsage, Failure> {
    if !value.is_object() {
        return Err(Failure::new("read-error"));
    }
    let mut result = ProviderUsage::empty("claude-code", "ready", SOURCE);
    for (field, key, minutes) in [
        ("five_hour", "session", 300),
        ("seven_day", "weekly", 10080),
    ] {
        let window = &value[field];
        // REST utilization is already a percentage. Stream utilization is a
        // fraction and is handled separately by provider_usage.rs.
        if let Some(used_percent) = valid_percent(window.get("utilization")) {
            result.windows.push(UsageWindow {
                key: key.into(),
                used_percent,
                window_minutes: Some(minutes),
                resets_at: reset_timestamp(window.get("resets_at")),
                observed_at: Some(observed_at.to_string()),
            });
        }
    }
    let extra = &value["extra_usage"];
    if extra["is_enabled"] == true
        && extra["monthly_limit"]
            .as_f64()
            .is_some_and(|limit| limit.is_finite() && limit > 0.0)
    {
        if let Some(used_percent) = valid_percent(extra.get("utilization")) {
            result.windows.push(UsageWindow {
                key: "monthly-extra".into(),
                used_percent,
                window_minutes: None,
                resets_at: reset_timestamp(extra.get("resets_at")),
                observed_at: Some(observed_at.to_string()),
            });
        }
    }
    if result.windows.is_empty() {
        return Err(Failure::new("unavailable"));
    }
    result.observed_at = Some(observed_at.to_string());
    Ok(result)
}

fn retry_delay(value: Option<&str>, now: u64) -> Option<u64> {
    let value = value?.trim();
    if value.len() > 128 {
        return None;
    }
    value.parse::<u64>().ok().or_else(|| {
        httpdate::parse_http_date(value)
            .ok()
            .map(|time| unix_seconds(time).saturating_sub(now))
    })
}

fn http_failure(status: u16, retry_after: Option<u64>) -> Failure {
    let reason = match status {
        401 | 403 => "authentication",
        404 | 405 | 410 => "unsupported",
        429 => "rate-limited",
        500..=599 => "network",
        _ => "unavailable",
    };
    Failure {
        reason,
        retry_after,
    }
}

fn fetch(login: &Login) -> Result<ProviderUsage, Failure> {
    let client = reqwest::blocking::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .connect_timeout(Duration::from_secs(5))
        .timeout(Duration::from_secs(10))
        .user_agent(concat!("Agentdeck/", env!("CARGO_PKG_VERSION")))
        .build()
        .map_err(|_| Failure::new("network"))?;
    let response = client
        .get(ENDPOINT)
        .bearer_auth(&login.token)
        .header("anthropic-beta", "oauth-2025-04-20")
        .send()
        .map_err(|_| Failure::new("network"))?;
    let now = unix_seconds(SystemTime::now());
    if !response.status().is_success() {
        let retry = retry_delay(
            response
                .headers()
                .get(reqwest::header::RETRY_AFTER)
                .and_then(|value| value.to_str().ok()),
            now,
        );
        return Err(http_failure(response.status().as_u16(), retry));
    }
    if response
        .content_length()
        .is_some_and(|length| length > MAX_BYTES)
    {
        return Err(Failure::new("read-error"));
    }
    let mut bytes = Vec::new();
    response
        .take(MAX_BYTES + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Failure::new("network"))?;
    if bytes.len() as u64 > MAX_BYTES {
        return Err(Failure::new("read-error"));
    }
    let value = serde_json::from_slice(&bytes).map_err(|_| Failure::new("read-error"))?;
    snapshot(&value, now)
}

#[derive(Default)]
struct Cache {
    identity: Option<u64>,
    oauth_owned: bool,
    last_success: Option<ProviderUsage>,
    last_attempt: Option<u64>,
    next_automatic: u64,
    next_manual: u64,
    reason: Option<&'static str>,
    failure_count: u32,
}

impl Cache {
    fn needs_fetch(&self, force: bool, now: u64) -> bool {
        self.last_attempt.is_none()
            || now
                >= if force {
                    self.next_manual
                } else {
                    self.next_automatic
                }
    }

    fn received(&mut self, result: Result<ProviderUsage, Failure>, now: u64) {
        self.last_attempt = Some(now);
        self.next_manual = now.saturating_add(MANUAL_COOLDOWN);
        self.next_automatic = now.saturating_add(CACHE_SECONDS);
        match result {
            Ok(snapshot) => {
                self.last_success = Some(snapshot);
                self.reason = None;
                self.failure_count = 0;
            }
            Err(error) => {
                self.reason = Some(error.reason);
                self.failure_count = self.failure_count.saturating_add(1);
                if error.reason == "authentication" {
                    // A rejected/revoked token no longer establishes whose
                    // account we can show, even when its local bytes match.
                    self.last_success = None;
                }
                if error.reason == "rate-limited" {
                    let exponential =
                        60u64.saturating_mul(1u64 << self.failure_count.saturating_sub(1).min(5));
                    let delay = error
                        .retry_after
                        .unwrap_or(exponential)
                        .max(MANUAL_COOLDOWN);
                    self.next_manual = now.saturating_add(delay);
                    self.next_automatic = self.next_automatic.max(self.next_manual);
                } else if let Some(delay) = error.retry_after {
                    self.next_manual = self.next_manual.max(now.saturating_add(delay));
                    self.next_automatic = self.next_automatic.max(self.next_manual);
                }
            }
        }
    }

    fn result(&self) -> ProviderUsage {
        let mut result = self
            .last_success
            .clone()
            .unwrap_or_else(|| ProviderUsage::empty("claude-code", "unavailable", SOURCE));
        if let Some(reason) = self.reason {
            result.status =
                if result.windows.is_empty() && matches!(reason, "unsupported" | "unavailable") {
                    "unavailable"
                } else {
                    "error"
                }
                .into();
            result.reason = Some(reason.into());
            result.retry_at = Some(self.next_manual);
        }
        result
    }
}

static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

fn read_cached(
    cache: &Mutex<Cache>,
    force: bool,
    now: u64,
    login: Result<Login, Failure>,
    fallback: ProviderUsage,
    fetcher: impl FnOnce(&Login) -> Result<ProviderUsage, Failure>,
) -> ProviderUsage {
    let started = Instant::now();
    let Ok(mut cache) = cache.lock() else {
        let mut result = ProviderUsage::empty("claude-code", "error", SOURCE);
        result.reason = Some("read-error".into());
        return result;
    };
    let login = match login {
        Ok(login) => login,
        Err(error) => {
            // Once OAuth owns the readings, generic local files/events may
            // belong to a prior login. Never resurrect them after auth loss.
            let may_use_fallback = !cache.oauth_owned
                && !matches!(
                    error.reason,
                    "missing-login" | "expired-login" | "authentication"
                )
                && !fallback.windows.is_empty();
            let mut result = if may_use_fallback {
                fallback
            } else {
                ProviderUsage::empty("claude-code", "unavailable", SOURCE)
            };
            cache.identity = None;
            cache.last_success = None;
            cache.last_attempt = None;
            cache.reason = None;
            result.reason = Some(error.reason.into());
            if matches!(error.reason, "read-error" | "authentication") {
                result.status = "error".into();
            }
            return result;
        }
    };
    if cache.identity != Some(login.identity) {
        cache.identity = Some(login.identity);
        cache.oauth_owned = true;
        cache.last_success = None;
        cache.last_attempt = None;
        cache.reason = None;
        cache.failure_count = 0;
        // Also invalidate in-memory stream windows collected under a prior
        // identity. They are not account-qualified and cannot override OAuth.
        if let Some(events) = super::CLAUDE_EVENTS.get() {
            if let Ok(mut events) = events.lock() {
                events.clear();
            }
        }
    }
    if cache.needs_fetch(force, now.saturating_add(started.elapsed().as_secs())) {
        let result = fetcher(&login);
        // `now` was sampled before IO. Round up the elapsed duration so a
        // Retry-After interval is never shortened by the request's latency.
        let completed = now
            .saturating_add(started.elapsed().as_secs())
            .saturating_add(1);
        cache.received(result, completed);
    }
    cache.result()
}

pub(super) fn read(force: bool, fallback: ProviderUsage) -> ProviderUsage {
    let now = unix_seconds(SystemTime::now());
    read_cached(
        CACHE.get_or_init(|| Mutex::new(Cache::default())),
        force,
        now,
        read_login(now),
        fallback,
        fetch,
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    };

    fn empty() -> ProviderUsage {
        ProviderUsage::empty("claude-code", "unavailable", "claude-statusline")
    }
    fn login(identity: u64) -> Result<Login, Failure> {
        Ok(Login {
            token: "synthetic-only".into(),
            identity,
        })
    }
    fn sample(now: u64) -> ProviderUsage {
        snapshot(
            &json!({"five_hour":{"utilization":100},"seven_day":{"utilization":85}}),
            now,
        )
        .unwrap()
    }

    #[test]
    fn rest_percentages_iso_resets_and_explicit_extra_monthly_are_preserved() {
        let usage = snapshot(&json!({"five_hour":{"utilization":100,"resets_at":"2026-10-06T20:00:00Z"},"seven_day":{"utilization":85,"resets_at":"2026-10-13T20:00:00+00:00"},"extra_usage":{"is_enabled":false,"monthly_limit":null,"utilization":null}}),100).unwrap();
        assert_eq!(usage.windows.len(), 2);
        assert_eq!(usage.windows[0].used_percent, 100.0);
        assert_eq!(usage.windows[1].used_percent, 85.0);
        assert_eq!(usage.windows[0].resets_at, Some(1791316800));
        let extra = snapshot(
            &json!({"extra_usage":{"is_enabled":true,"monthly_limit":10000,"utilization":12.5}}),
            100,
        )
        .unwrap();
        assert_eq!(extra.windows[0].key, "monthly-extra");
        assert_eq!(extra.windows[0].used_percent, 12.5);
        assert!(snapshot(
            &json!({"extra_usage":{"is_enabled":true,"monthly_limit":0,"utilization":50}}),
            100
        )
        .is_err());
        assert!(snapshot(
            &json!({"five_hour":{"utilization":null},"seven_day":{"utilization":-1}}),
            100
        )
        .is_err());
    }

    #[test]
    fn authentication_is_validated_and_never_serialized() {
        let path = Path::new("fixture/.credentials.json");
        let data =
            br#"{"claudeAiOauth":{"accessToken":"SYNTHETIC_SECRET_ONLY","expiresAt":2000000}}"#;
        let parsed = parse_login(data, path, 1000).unwrap();
        assert_eq!(parsed.token, "SYNTHETIC_SECRET_ONLY");
        assert_eq!(
            parse_login(data, path, 2000).err().unwrap().reason,
            "expired-login"
        );
        assert_eq!(
            parse_login(b"invalid", path, 0).err().unwrap().reason,
            "read-error"
        );
        assert_eq!(
            parse_login(br#"{}"#, path, 0).err().unwrap().reason,
            "unsupported"
        );
        assert_eq!(http_failure(401, None).reason, "authentication");
        assert_eq!(http_failure(403, None).reason, "authentication");
        let environment = login_from_token(
            "SYNTHETIC_SECRET_ONLY",
            Path::new("environment:CLAUDE_CODE_OAUTH_TOKEN"),
        )
        .unwrap();
        assert_ne!(parsed.identity, environment.identity);
        assert!(login_from_token("bad\r\nheader", path).is_err());
        let serialized = serde_json::to_string(&sample(100)).unwrap();
        assert!(
            !serialized.contains("SYNTHETIC_SECRET_ONLY") && !serialized.contains("accessToken")
        );
    }

    #[test]
    fn cache_manual_cooldown_and_server_backoff_prevent_polling() {
        let mut cache = Cache::default();
        assert!(cache.needs_fetch(false, 100));
        cache.received(Ok(sample(100)), 100);
        assert!(!cache.needs_fetch(true, 159));
        assert!(cache.needs_fetch(true, 160));
        assert!(!cache.needs_fetch(false, 399));
        assert!(cache.needs_fetch(false, 400));
        cache.received(Err(http_failure(429, Some(600))), 160);
        assert!(!cache.needs_fetch(true, 759));
        assert!(cache.needs_fetch(true, 760));
        let value = cache.result();
        assert_eq!(value.windows[1].used_percent, 85.0);
        assert_eq!(value.observed_at.as_deref(), Some("100"));
        assert_eq!(value.status, "error");
        assert_eq!(value.reason.as_deref(), Some("rate-limited"));
        assert_eq!(value.retry_at, Some(760));
        assert_eq!(retry_delay(Some("120"), 100), Some(120));
        assert_eq!(
            retry_delay(Some("Thu, 01 Jan 1970 00:05:00 GMT"), 100),
            Some(200)
        );
        cache.received(Err(http_failure(401, None)), 800);
        assert!(
            cache.result().windows.is_empty(),
            "Revoked credentials cannot retain account percentages"
        );
    }

    #[test]
    fn changed_or_missing_login_never_resurrects_old_account_fallback() {
        let cache = Mutex::new(Cache::default());
        let first = read_cached(&cache, false, 100, login(1), empty(), |_| Ok(sample(100)));
        assert_eq!(first.windows.len(), 2);
        let changed = read_cached(&cache, false, 101, login(2), sample(100), |_| {
            Err(Failure::new("network"))
        });
        assert!(changed.windows.is_empty());
        let missing = read_cached(
            &cache,
            false,
            102,
            Err(Failure::new("missing-login")),
            sample(100),
            |_| panic!("no network without login"),
        );
        assert!(missing.windows.is_empty());
        assert_eq!(missing.reason.as_deref(), Some("missing-login"));
        let restored = read_cached(&cache, false, 103, login(2), empty(), |_| Ok(sample(103)));
        assert_eq!(restored.observed_at.as_deref(), Some("103"));
        for reason in ["missing-login", "expired-login"] {
            let restarted = Mutex::new(Cache::default());
            let value = read_cached(
                &restarted,
                false,
                104,
                Err(Failure::new(reason)),
                sample(100),
                |_| panic!("no network without login"),
            );
            assert!(
                value.windows.is_empty(),
                "Startup cannot restore a previous account's generic file"
            );
        }
    }

    #[test]
    fn concurrent_forced_consumers_share_one_fetch() {
        let cache = Arc::new(Mutex::new(Cache::default()));
        let calls = Arc::new(AtomicUsize::new(0));
        let threads: Vec<_> = (0..8)
            .map(|_| {
                let cache = cache.clone();
                let calls = calls.clone();
                std::thread::spawn(move || {
                    read_cached(&cache, true, 100, login(1), empty(), |_| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(sample(100))
                    })
                })
            })
            .collect();
        for thread in threads {
            assert_eq!(thread.join().unwrap().windows.len(), 2);
        }
        assert_eq!(calls.load(Ordering::SeqCst), 1);
    }
}
