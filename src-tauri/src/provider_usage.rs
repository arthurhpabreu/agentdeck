//! Provider subscription limits. Claude reads its existing local login only in
//! the backend; authentication material never leaves the usage collector.
#[path = "provider_usage_claude.rs"]
mod claude;
use serde::Serialize;
use serde_json::Value;
use std::{
    fs::{self, File},
    io::{Read, Seek, SeekFrom},
    path::{Path, PathBuf},
    sync::{Mutex, OnceLock},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

const MAX_TAIL_BYTES: u64 = 1024 * 1024;
const MAX_FILES: usize = 16;
const MAX_ENTRIES: usize = 4096;

#[derive(Clone, Debug, Serialize)]
pub struct UsageWindow {
    key: String,
    used_percent: f64,
    window_minutes: Option<u64>,
    resets_at: Option<u64>,
    observed_at: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct ProviderUsage {
    provider: String,
    status: String,
    windows: Vec<UsageWindow>,
    observed_at: Option<String>,
    source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    retry_at: Option<u64>,
}

impl ProviderUsage {
    fn empty(provider: &str, status: &str, source: &str) -> Self {
        Self {
            provider: provider.into(),
            status: status.into(),
            windows: Vec::new(),
            observed_at: None,
            source: source.into(),
            reason: None,
            retry_at: None,
        }
    }
}

struct CachedUsage {
    at: Instant,
    values: Vec<ProviderUsage>,
}
static CACHE: OnceLock<Mutex<Option<CachedUsage>>> = OnceLock::new();
static CLAUDE_EVENTS: OnceLock<Mutex<Vec<UsageWindow>>> = OnceLock::new();

fn unix_seconds(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn valid_percent(value: Option<&Value>) -> Option<f64> {
    value
        .and_then(Value::as_f64)
        .filter(|v| v.is_finite() && *v >= 0.0)
}

fn window_key(minutes: Option<u64>, fallback: &str) -> String {
    match minutes {
        Some(10080) => "weekly".into(),
        Some(40320..=44640) => "monthly".into(),
        Some(300) => "session".into(),
        Some(n) => format!("window-{n}"),
        None => fallback.into(),
    }
}

fn codex_snapshot(value: &Value, modified: u64) -> Option<ProviderUsage> {
    // Do not interpret text, tool results, or nested examples as account telemetry.
    if value.get("type")?.as_str()? != "event_msg" {
        return None;
    }
    let payload = value.get("payload")?;
    if payload.get("type")?.as_str()? != "token_count" {
        return None;
    }
    let limits = payload.get("rate_limits")?;
    if limits
        .get("limit_id")
        .and_then(Value::as_str)
        .is_some_and(|id| id != "codex")
    {
        return None; // Model-specific buckets are not the account-wide Codex limit.
    }
    let mut snapshot = ProviderUsage::empty("codex", "ready", "codex-rollout");
    for name in ["primary", "secondary"] {
        let Some(window) = limits.get(name) else {
            continue;
        };
        let Some(used_percent) = valid_percent(window.get("used_percent")) else {
            continue;
        };
        let minutes = window
            .get("window_minutes")
            .or_else(|| window.get("window_duration_mins"))
            .and_then(Value::as_u64);
        snapshot.windows.push(UsageWindow {
            key: window_key(minutes, name),
            used_percent,
            window_minutes: minutes,
            resets_at: window
                .get("resets_at")
                .or_else(|| window.get("reset_at"))
                .and_then(Value::as_u64),
            observed_at: None,
        });
    }
    if snapshot.windows.is_empty() {
        return None;
    }
    snapshot.observed_at = Some(
        value
            .get("timestamp")
            .and_then(Value::as_str)
            .map(str::to_owned)
            .unwrap_or_else(|| modified.to_string()),
    );
    Some(snapshot)
}

fn claude_snapshot(value: &Value, modified: u64) -> Option<ProviderUsage> {
    let limits = value.get("rate_limits")?;
    let mut snapshot = ProviderUsage::empty("claude-code", "ready", "claude-statusline");
    for (name, key, minutes) in [
        ("five_hour", "session", Some(300)),
        ("seven_day", "weekly", Some(10080)),
        ("spend_limit", "spend", None),
    ] {
        let Some(window) = limits.get(name) else {
            continue;
        };
        let Some(used_percent) = valid_percent(window.get("used_percentage")) else {
            continue;
        };
        let key = if name == "spend_limit" {
            match window.get("period").and_then(Value::as_str) {
                Some("monthly") => "monthly-spend",
                Some("weekly") => "spend-weekly",
                Some("daily") => "spend-daily",
                _ => key,
            }
        } else {
            key
        };
        snapshot.windows.push(UsageWindow {
            key: key.into(),
            used_percent,
            window_minutes: minutes,
            resets_at: window.get("resets_at").and_then(Value::as_u64),
            observed_at: None,
        });
    }
    if snapshot.windows.is_empty() {
        return None;
    }
    snapshot.observed_at = Some(modified.to_string());
    Some(snapshot)
}

// Newest folders first makes a long-lived Codex installation cheap to inspect.
// Enumeration, file count, bytes read, and depth all have hard caps.
fn collect_rollouts(
    root: &Path,
    depth: usize,
    budget: &mut usize,
    output: &mut Vec<(PathBuf, SystemTime)>,
) -> std::io::Result<()> {
    if depth > 4 || *budget == 0 || output.len() >= MAX_FILES {
        return Ok(());
    }
    let mut entries = Vec::new();
    for entry in fs::read_dir(root)? {
        if *budget == 0 {
            break;
        }
        *budget -= 1;
        let entry = entry?;
        let kind = entry.file_type()?;
        if kind.is_symlink() {
            continue;
        }
        entries.push((entry, kind));
    }
    entries.sort_by(|(a, _), (b, _)| b.file_name().cmp(&a.file_name()));
    for (entry, kind) in entries {
        if output.len() >= MAX_FILES {
            break;
        }
        if kind.is_dir() {
            let _ = collect_rollouts(&entry.path(), depth + 1, budget, output);
        } else if kind.is_file()
            && entry.file_name().to_string_lossy().starts_with("rollout-")
            && entry.path().extension().is_some_and(|ext| ext == "jsonl")
        {
            if let Ok(metadata) = entry.metadata() {
                output.push((entry.path(), metadata.modified().unwrap_or(UNIX_EPOCH)));
            }
        }
    }
    Ok(())
}

fn read_tail(path: &Path) -> std::io::Result<String> {
    let mut file = File::open(path)?;
    let length = file.metadata()?.len();
    let start = length.saturating_sub(MAX_TAIL_BYTES);
    file.seek(SeekFrom::Start(start))?;
    let mut data = Vec::new();
    file.take(MAX_TAIL_BYTES).read_to_end(&mut data)?;
    // Drop a potentially partial JSON line. Lossy UTF-8 is safe: only numbers
    // and fixed schema fields from valid JSON events leave this module.
    let text = String::from_utf8_lossy(&data);
    Ok(if start > 0 {
        text.split_once('\n')
            .map(|(_, rest)| rest)
            .unwrap_or("")
            .to_owned()
    } else {
        text.into_owned()
    })
}

fn read_codex_usage() -> ProviderUsage {
    let root = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .or_else(|| crate::util::home_dir().map(|p| p.join(".codex")));
    let Some(root) = root else {
        return ProviderUsage::empty("codex", "unavailable", "codex-rollout");
    };
    let mut files = Vec::new();
    let mut budget = MAX_ENTRIES;
    if let Err(error) = collect_rollouts(&root.join("sessions"), 0, &mut budget, &mut files) {
        let status = if error.kind() == std::io::ErrorKind::NotFound {
            "unavailable"
        } else {
            "error"
        };
        return ProviderUsage::empty("codex", status, "codex-rollout");
    }
    files.sort_by(|a, b| b.1.cmp(&a.1));
    let mut latest: Option<ProviderUsage> = None;
    let mut read_error = false;
    for (path, modified) in files {
        let data = match read_tail(&path) {
            Ok(data) => data,
            Err(_) => {
                read_error = true;
                continue;
            }
        };
        for line in data
            .lines()
            .rev()
            .filter(|line| line.contains("\"rate_limits\""))
        {
            let Ok(value) = serde_json::from_str::<Value>(line) else {
                continue;
            };
            if let Some(snapshot) = codex_snapshot(&value, unix_seconds(modified)) {
                if latest
                    .as_ref()
                    .is_none_or(|previous| snapshot.observed_at > previous.observed_at)
                {
                    latest = Some(snapshot);
                }
                break;
            }
        }
    }
    latest.unwrap_or_else(|| {
        ProviderUsage::empty(
            "codex",
            if read_error { "error" } else { "unavailable" },
            "codex-rollout",
        )
    })
}

fn usage_dir() -> Option<PathBuf> {
    crate::util::home_dir().map(|p| p.join(".agentdeck").join("usage"))
}

const CLAUDE_STATUSLINE_PS: &str = r#"$ErrorActionPreference = 'Stop'
try {
  $data = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $safe = @{}
  foreach ($name in @('five_hour', 'seven_day', 'spend_limit')) {
    $window = $data.rate_limits.$name
    if ($null -ne $window) {
      $safe[$name] = @{}
      foreach ($field in @('used_percentage', 'resets_at', 'period')) {
        if ($null -ne $window.$field) { $safe[$name][$field] = $window.$field }
      }
    }
  }
  if ($safe.Count -eq 0) { [Console]::Write('AgentDeck'); exit 0 }
  $destination = Join-Path $PSScriptRoot 'claude.json'
  $temporary = Join-Path $PSScriptRoot (([guid]::NewGuid().ToString()) + '.tmp')
  $json = @{ rate_limits = $safe } | ConvertTo-Json -Depth 8 -Compress
  [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
  Move-Item -LiteralPath $temporary -Destination $destination -Force
} catch {}
[Console]::Write('AgentDeck')
"#;

const CLAUDE_STATUSLINE_PY: &str = r#"import json, os, sys, tempfile
try:
    data = json.load(sys.stdin).get('rate_limits', {}) or {}
    safe = {name: {field: value for field, value in window.items() if field in ('used_percentage', 'resets_at', 'period')}
            for name, window in data.items() if name in ('five_hour', 'seven_day', 'spend_limit') and isinstance(window, dict)}
    if not safe:
        print('AgentDeck', end='')
        sys.exit(0)
    directory = os.path.dirname(os.path.abspath(__file__))
    with tempfile.NamedTemporaryFile(mode='w', dir=directory, delete=False, encoding='utf-8') as output:
        json.dump({'rate_limits': safe}, output)
        temporary = output.name
    os.replace(temporary, os.path.join(directory, 'claude.json'))
except Exception:
    pass
print('AgentDeck', end='')
"#;

fn settings_has_statusline(path: &Path) -> bool {
    let file = match File::open(path) {
        Ok(file) => file,
        Err(error) => return error.kind() != std::io::ErrorKind::NotFound,
    };
    let mut content = String::new();
    // If an existing settings file cannot be safely understood, leave it alone.
    if file.take(1024 * 1024).read_to_string(&mut content).is_err() {
        return true;
    }
    serde_json::from_str::<Value>(content.trim_start_matches('\u{feff}'))
        .map(|value| value.get("statusLine").is_some())
        .unwrap_or(true)
}

fn write_if_changed(path: &Path, content: &str) -> std::io::Result<()> {
    if fs::read_to_string(path).ok().as_deref() != Some(content) {
        fs::write(path, content)?;
    }
    Ok(())
}

/// A per-process --settings overlay; never rewrites the user's Claude settings.
pub fn apply_claude_statusline(cli_path: &str, workdir: &str, args: &mut Vec<String>) {
    let position = args
        .iter()
        .position(|arg| arg == "--settings" || arg.starts_with("--settings="));
    if let Some(position) = position {
        let inline = args[position].starts_with("--settings=");
        let value = args[position]
            .strip_prefix("--settings=")
            .or_else(|| args.get(position + 1).map(String::as_str));
        let Some(mut settings) = value.and_then(|value| {
            if value.trim_start().starts_with('{') {
                serde_json::from_str::<serde_json::Value>(value).ok()
            } else {
                let file =
                    File::open(crate::util::resolve_path_from_workdir(workdir, value)).ok()?;
                let mut data = String::new();
                file.take(1024 * 1024).read_to_string(&mut data).ok()?;
                serde_json::from_str(&data).ok()
            }
        }) else {
            return;
        };
        if !settings.is_object() || settings.get("statusLine").is_some() {
            return;
        }
        let Some(path) = claude_statusline_settings(cli_path, workdir, &[]) else {
            return;
        };
        let Some(overlay) = fs::read(path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        else {
            return;
        };
        settings["statusLine"] = overlay["statusLine"].clone();
        // Keep each session's effort/fast/ultracode choices isolated, including when RTK is off.
        if inline {
            args[position] = format!("--settings={settings}");
        } else {
            args[position + 1] = settings.to_string();
        }
    } else if let Some(settings) = claude_statusline_settings(cli_path, workdir, args) {
        args.extend(["--settings".to_string(), settings]);
    }
}

/// A per-process --settings overlay; never rewrites the user's Claude settings.
/// Custom status lines keep ownership of their existing behavior.
pub fn claude_statusline_settings(
    cli_path: &str,
    workdir: &str,
    args: &[String],
) -> Option<String> {
    if args
        .iter()
        .any(|arg| arg == "--settings" || arg.starts_with("--settings="))
    {
        return None;
    }
    if let Some(settings) =
        crate::util::resolve_provider_file_path("claude-code", cli_path, "settings.json")
    {
        if settings_has_statusline(&settings) {
            return None;
        }
    }
    for dir in Path::new(workdir).ancestors().take(24) {
        for name in ["settings.json", "settings.local.json"] {
            if settings_has_statusline(&dir.join(".claude").join(name)) {
                return None;
            }
        }
    }
    let directory = usage_dir()?;
    fs::create_dir_all(&directory).ok()?;
    let command = if cfg!(windows) {
        let script = directory.join("claude-statusline.ps1");
        write_if_changed(&script, CLAUDE_STATUSLINE_PS).ok()?;
        format!("powershell.exe -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File \"{}\"", script.display())
    } else {
        let script = directory.join("claude-statusline.py");
        write_if_changed(&script, CLAUDE_STATUSLINE_PY).ok()?;
        format!(
            "/usr/bin/python3 '{}'",
            script.to_string_lossy().replace('\'', "'\\''")
        )
    };
    let settings =
        serde_json::json!({"statusLine":{"type":"command","command":command}}).to_string();
    let path = directory.join("claude-statusline-settings.json");
    write_if_changed(&path, &settings).ok()?;
    Some(path.to_string_lossy().to_string())
}

fn read_claude_usage() -> ProviderUsage {
    let empty = |status| ProviderUsage::empty("claude-code", status, "claude-statusline");
    let Some(path) = usage_dir().map(|p| p.join("claude.json")) else {
        return empty("unavailable");
    };
    let file = match File::open(&path) {
        Ok(file) => file,
        Err(error) => {
            return empty(if error.kind() == std::io::ErrorKind::NotFound {
                "unavailable"
            } else {
                "error"
            })
        }
    };
    let modified = file
        .metadata()
        .and_then(|m| m.modified())
        .map(unix_seconds)
        .unwrap_or(0);
    let mut data = String::new();
    if file.take(64 * 1024).read_to_string(&mut data).is_err() {
        return empty("error");
    }
    serde_json::from_str::<Value>(data.trim_start_matches('\u{feff}'))
        .ok()
        .and_then(|v| claude_snapshot(&v, modified))
        .unwrap_or_else(|| empty("unavailable"))
}

fn claude_event_window(record: &Value, captured: u64) -> Option<UsageWindow> {
    if record.get("type")?.as_str()? != "rate_limit_event" {
        return None;
    }
    let info = record
        .get("rate_limit_info")
        .or_else(|| record.get("rateLimitInfo"))?;
    let utilization = valid_percent(info.get("utilization")).filter(|value| *value <= 1.0)?;
    // SDKRateLimitInfo.utilization is a fraction. Missing values remain unknown.
    let (key, minutes) = match info
        .get("rateLimitType")
        .or_else(|| info.get("rate_limit_type"))?
        .as_str()?
    {
        "five_hour" => ("session", 300),
        "seven_day" => ("weekly", 10080),
        _ => return None,
    };
    Some(UsageWindow {
        key: key.into(),
        used_percent: utilization * 100.0,
        window_minutes: Some(minutes),
        resets_at: info
            .get("resetsAt")
            .or_else(|| info.get("resets_at"))
            .and_then(Value::as_u64),
        observed_at: Some(captured.to_string()),
    })
}

pub fn ingest_claude_rate_limit(app: &tauri::AppHandle, record: &Value) {
    use tauri::Emitter;
    let Some(window) = claude_event_window(record, unix_seconds(SystemTime::now())) else {
        return;
    };
    if let Ok(mut events) = CLAUDE_EVENTS.get_or_init(|| Mutex::new(Vec::new())).lock() {
        events.retain(|previous| previous.key != window.key);
        events.push(window);
    }
    if let Ok(mut cache) = CACHE.get_or_init(|| Mutex::new(None)).lock() {
        *cache = None;
    }
    let _ = app.emit("provider-usage-updated", ());
}

fn merge_claude_events(mut usage: ProviderUsage) -> ProviderUsage {
    if let Ok(events) = CLAUDE_EVENTS.get_or_init(|| Mutex::new(Vec::new())).lock() {
        let file_time = usage
            .observed_at
            .as_ref()
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0);
        for window in events.iter().filter(|window| {
            window
                .observed_at
                .as_ref()
                .and_then(|v| v.parse::<u64>().ok())
                .unwrap_or(0)
                >= file_time
        }) {
            usage.windows.retain(|previous| previous.key != window.key);
            usage.windows.push(window.clone());
            usage.status = "ready".into();
            usage.source = "claude-stream".into();
        }
    }
    usage
}

/// A sanitized, read-only diagnostic. It uses the same cooldown and account
/// isolation as the footer and never serializes authentication information.
pub fn diagnostic_claude_usage() -> ProviderUsage {
    claude::read(true, merge_claude_events(read_claude_usage()))
}

/// Repeated mounted consumers share one scan; IO stays off Tauri's UI thread.
#[tauri::command]
pub async fn get_provider_usage(force: Option<bool>) -> Result<Vec<ProviderUsage>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut cache = CACHE
            .get_or_init(|| Mutex::new(None))
            .lock()
            .map_err(|_| "usage-cache-unavailable".to_owned())?;
        if let Some(cached) = cache
            .as_ref()
            .filter(|c| !force.unwrap_or(false) && c.at.elapsed() < Duration::from_secs(10))
        {
            return Ok(cached.values.clone());
        }
        let values = vec![
            read_codex_usage(),
            claude::read(
                force.unwrap_or(false),
                merge_claude_events(read_claude_usage()),
            ),
        ];
        *cache = Some(CachedUsage {
            at: Instant::now(),
            values: values.clone(),
        });
        Ok(values)
    })
    .await
    .map_err(|_| "usage-read-failed".to_owned())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_real_codex_windows_without_inventing_monthly() {
        let input = json!({"type":"event_msg", "timestamp":"2026-10-06T16:00:00Z", "payload":{"type":"token_count","rate_limits":{"limit_id":"codex","primary":{"used_percent":0.0,"window_minutes":300,"resets_at":2000000000},"secondary":{"used_percent":48.5,"window_minutes":10080}}}});
        let value = codex_snapshot(&input, 0).unwrap();
        assert_eq!(value.windows.len(), 2);
        assert_eq!(value.windows[0].used_percent, 0.0);
        assert_eq!(value.windows[1].key, "weekly");
        assert_eq!(value.observed_at.as_deref(), Some("2026-10-06T16:00:00Z"));
    }

    #[test]
    fn rejects_other_buckets_and_tool_payloads() {
        let mut input = json!({"type":"event_msg","payload":{"type":"token_count","rate_limits":{"limit_id":"codex_spark","primary":{"used_percent":20,"window_minutes":300}}}});
        assert!(codex_snapshot(&input, 0).is_none());
        input["payload"]["rate_limits"]["limit_id"] = json!("codex");
        input["payload"]["type"] = json!("tool_result");
        assert!(codex_snapshot(&input, 0).is_none());
    }

    #[test]
    fn claude_only_marks_monthly_when_provider_supplies_the_period() {
        let input = json!({"rate_limits":{"five_hour":{"used_percentage":17.2},"seven_day":{"used_percentage":null},"spend_limit":{"used_percentage":112.5,"period":"monthly","resets_at":2000000000}}});
        let usage = claude_snapshot(&input, 10).unwrap();
        assert_eq!(usage.windows.len(), 2);
        assert_eq!(usage.windows[1].key, "monthly-spend");
        assert_eq!(usage.windows[1].used_percent, 112.5);
        assert_eq!(window_key(None, "secondary"), "secondary");
        assert_eq!(window_key(Some(1440), "primary"), "window-1440");
    }

    #[test]
    fn never_turns_missing_or_negative_percent_into_zero() {
        assert!(valid_percent(None).is_none());
        assert!(valid_percent(Some(&json!(-1))).is_none());
        assert!(claude_snapshot(&json!({"rate_limits":{"seven_day":{}}}), 0).is_none());
    }

    #[test]
    fn stream_events_use_fraction_and_do_not_invent_missing_utilization() {
        let input = json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","utilization":0.83,"rateLimitType":"seven_day","resetsAt":2000000000}});
        let window = claude_event_window(&input, 100).unwrap();
        assert_eq!(window.used_percent, 83.0);
        assert_eq!(window.key, "weekly");
        assert_eq!(window.observed_at.as_deref(), Some("100"));
        assert!(claude_event_window(&json!({"type":"rate_limit_event","rate_limit_info":{"status":"allowed","rateLimitType":"seven_day"}}), 100).is_none());
    }
}
