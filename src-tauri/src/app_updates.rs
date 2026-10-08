//! Stable releases from the official repository. Only verified app-owned installers
//! can be opened; the frontend never supplies a download URL or executable path.
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File},
    io::{Read, Write},
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
    time::Duration,
};
use tauri::Manager;
use tauri_plugin_opener::OpenerExt;

const LATEST: &str = "https://api.github.com/repos/arthurhpabreu/agentdeck/releases/latest";
const DOWNLOAD_ROOT: &str = "https://github.com/arthurhpabreu/agentdeck/releases/download";
const MAX_INSTALLER_BYTES: u64 = 256 * 1024 * 1024;
const MAX_METADATA_BYTES: u64 = 256 * 1024;
const MAX_CHECKSUM_BYTES: u64 = 16 * 1024;

#[derive(Default)]
pub struct AppUpdateState {
    downloading: AtomicBool,
    installer: Mutex<Option<VerifiedInstaller>>,
}
struct VerifiedInstaller {
    path: PathBuf,
    sha256: String,
    size: u64,
    kind: InstallerKind,
}
#[derive(Clone, Copy)]
enum InstallerKind {
    Nsis,
    Msi,
}
impl InstallerKind {
    fn label(self) -> &'static str {
        match self {
            Self::Nsis => "exe",
            Self::Msi => "msi",
        }
    }
    fn filename(self, version: &str) -> String {
        match self {
            Self::Nsis => format!("Agentdeck_{version}_x64-setup.exe"),
            Self::Msi => format!("Agentdeck_{version}_x64_en-US.msi"),
        }
    }
    fn magic(self) -> &'static [u8] {
        match self {
            Self::Nsis => b"MZ",
            Self::Msi => &[0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1],
        }
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppUpdateInfo {
    installed: String,
    latest: String,
    update_available: bool,
    supported: bool,
    installer_kind: String,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadedUpdate {
    version: String,
    filename: String,
}
#[derive(Deserialize)]
struct Release {
    tag_name: String,
    draft: bool,
    prerelease: bool,
    assets: Vec<Asset>,
}
#[derive(Clone, Deserialize)]
struct Asset {
    name: String,
    browser_download_url: String,
    size: u64,
}
struct UpdateRelease {
    version: String,
    installer: Asset,
    checksums: Asset,
}

fn version(value: &str) -> Result<[u64; 3], String> {
    let parts = value.split('.').collect::<Vec<_>>();
    if parts.len() != 3
        || parts
            .iter()
            .any(|p| p.is_empty() || p.len() > 9 || !p.bytes().all(|b| b.is_ascii_digit()))
    {
        return Err("release_invalid".into());
    }
    Ok([
        parts[0].parse().map_err(|_| "release_invalid")?,
        parts[1].parse().map_err(|_| "release_invalid")?,
        parts[2].parse().map_err(|_| "release_invalid")?,
    ])
}
fn official_asset(release: &Release, name: &str, max_size: u64) -> Result<Asset, String> {
    let asset = release
        .assets
        .iter()
        .find(|a| a.name == name)
        .ok_or("release_assets_missing")?;
    if asset.size == 0
        || asset.size > max_size
        || asset.browser_download_url != format!("{DOWNLOAD_ROOT}/{}/{name}", release.tag_name)
    {
        return Err("release_invalid".into());
    }
    Ok(asset.clone())
}
fn select_release(
    release: Release,
    installed: &str,
    kind: InstallerKind,
) -> Result<Option<UpdateRelease>, String> {
    let latest = release
        .tag_name
        .strip_prefix('v')
        .ok_or("release_invalid")?;
    let latest_version = version(latest)?;
    if release.draft || release.prerelease {
        return Err("release_invalid".into());
    }
    if latest_version <= version(installed)? {
        return Ok(None);
    }
    let installer = official_asset(&release, &kind.filename(latest), MAX_INSTALLER_BYTES)?;
    let checksums = official_asset(&release, "SHA256SUMS.txt", MAX_CHECKSUM_BYTES)?;
    Ok(Some(UpdateRelease {
        version: latest.into(),
        installer,
        checksums,
    }))
}
fn client(timeout: u64) -> Result<Client, String> {
    Client::builder()
        .user_agent(concat!("Agentdeck/", env!("CARGO_PKG_VERSION")))
        .connect_timeout(Duration::from_secs(10))
        .timeout(Duration::from_secs(timeout))
        .redirect(reqwest::redirect::Policy::custom(|attempt| {
            let url = attempt.url();
            if attempt.previous().len() >= 5
                || url.scheme() != "https"
                || !matches!(
                    url.host_str(),
                    Some(
                        "github.com"
                            | "api.github.com"
                            | "release-assets.githubusercontent.com"
                            | "objects.githubusercontent.com"
                    )
                )
            {
                attempt.error("untrusted release redirect")
            } else {
                attempt.follow()
            }
        }))
        .build()
        .map_err(|_| "network_unavailable".into())
}
fn fetch_bounded(client: &Client, url: &str, limit: u64) -> Result<Vec<u8>, String> {
    let response = client
        .get(url)
        .header("Accept", "application/vnd.github+json")
        .send()
        .and_then(|r| r.error_for_status())
        .map_err(|_| "network_unavailable")?;
    let mut bytes = Vec::new();
    response
        .take(limit + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| "network_unavailable")?;
    if bytes.len() as u64 > limit {
        return Err("release_invalid".into());
    }
    Ok(bytes)
}
fn latest_release(client: &Client) -> Result<Release, String> {
    serde_json::from_slice(&fetch_bounded(client, LATEST, MAX_METADATA_BYTES)?)
        .map_err(|_| "release_invalid".into())
}
fn checksum(text: &str, filename: &str) -> Result<String, String> {
    let mut found = None;
    for line in text.lines() {
        let fields = line.split_whitespace().collect::<Vec<_>>();
        if fields.len() != 2 || fields[1].trim_start_matches('*') != filename {
            continue;
        }
        if found.is_some()
            || fields[0].len() != 64
            || !fields[0].bytes().all(|b| b.is_ascii_hexdigit())
        {
            return Err("checksum_invalid".into());
        }
        found = Some(fields[0].to_ascii_lowercase());
    }
    found.ok_or_else(|| "checksum_invalid".into())
}
fn copy_verified(
    mut source: impl Read,
    mut destination: impl Write,
    size: u64,
    sha256: &str,
    kind: InstallerKind,
) -> Result<(), String> {
    if size < kind.magic().len() as u64 || size > MAX_INSTALLER_BYTES {
        return Err("installer_invalid".into());
    }
    let mut digest = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    let mut prefix: Vec<u8> = Vec::new();
    let mut received = 0u64;
    loop {
        let count = source.read(&mut buffer).map_err(|_| "download_failed")?;
        if count == 0 {
            break;
        }
        received += count as u64;
        if received > size {
            return Err("installer_invalid".into());
        }
        prefix.extend(
            buffer[..count]
                .iter()
                .take(kind.magic().len().saturating_sub(prefix.len())),
        );
        digest.update(&buffer[..count]);
        destination
            .write_all(&buffer[..count])
            .map_err(|_| "download_failed")?;
    }
    if received != size || prefix != kind.magic() || format!("{:x}", digest.finalize()) != sha256 {
        return Err("checksum_mismatch".into());
    }
    Ok(())
}

// Prefer the installed package type so MSI users receive an MSI upgrade too.
fn installer_kind() -> InstallerKind {
    match tauri::utils::platform::bundle_type() {
        Some(tauri::utils::config::BundleType::Msi) => InstallerKind::Msi,
        _ => InstallerKind::Nsis,
    }
}
#[tauri::command]
pub async fn check_app_update() -> Result<AppUpdateInfo, String> {
    tauri::async_runtime::spawn_blocking(|| {
        let installed = env!("CARGO_PKG_VERSION");
        let kind = installer_kind();
        let supported = cfg!(all(target_os = "windows", target_arch = "x86_64"));
        let mut info = AppUpdateInfo {
            installed: installed.into(),
            latest: installed.into(),
            update_available: false,
            supported,
            installer_kind: kind.label().into(),
        };
        if !supported {
            return Ok(info);
        }
        let release = latest_release(&client(15)?)?;
        info.latest = release
            .tag_name
            .strip_prefix('v')
            .ok_or("release_invalid")?
            .into();
        if let Some(release) = select_release(release, installed, kind)? {
            info.latest = release.version;
            info.update_available = true;
        }
        Ok(info)
    })
    .await
    .map_err(|_| "update_check_failed".to_owned())?
}
struct DownloadGuard<'a>(&'a AtomicBool);
impl Drop for DownloadGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}
struct PartialDownload(PathBuf);
impl Drop for PartialDownload {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        if let Some(parent) = self.0.parent() {
            let _ = fs::remove_dir(parent);
        }
    }
}
#[tauri::command]
pub async fn download_app_update(app: tauri::AppHandle) -> Result<DownloadedUpdate, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if !cfg!(all(target_os = "windows", target_arch = "x86_64")) {
            return Err("unsupported_platform".into());
        }
        let state = app.state::<AppUpdateState>();
        if state.downloading.swap(true, Ordering::AcqRel) {
            return Err("update_busy".into());
        }
        let _guard = DownloadGuard(&state.downloading);
        let kind = installer_kind();
        let client = client(180)?;
        let release = select_release(latest_release(&client)?, env!("CARGO_PKG_VERSION"), kind)?
            .ok_or("no_update")?;
        let checksums = fetch_bounded(
            &client,
            &release.checksums.browser_download_url,
            MAX_CHECKSUM_BYTES,
        )?;
        let expected = checksum(
            std::str::from_utf8(&checksums)
                .map_err(|_| "checksum_invalid")?
                .trim_start_matches('\u{feff}'),
            &release.installer.name,
        )?;
        let directory = app
            .path()
            .app_cache_dir()
            .map_err(|_| "download_failed")?
            .join("updates")
            .join(uuid::Uuid::new_v4().to_string());
        fs::create_dir_all(&directory).map_err(|_| "download_failed")?;
        let partial = PartialDownload(directory.join("installer.part"));
        let path = directory.join(&release.installer.name);
        let response = client
            .get(&release.installer.browser_download_url)
            .send()
            .and_then(|r| r.error_for_status())
            .map_err(|_| "network_unavailable")?;
        let mut file = File::options()
            .write(true)
            .create_new(true)
            .open(&partial.0)
            .map_err(|_| "download_failed")?;
        copy_verified(response, &mut file, release.installer.size, &expected, kind)?;
        file.sync_all().map_err(|_| "download_failed")?;
        drop(file);
        fs::rename(&partial.0, &path).map_err(|_| "download_failed")?;
        *state.installer.lock().map_err(|_| "download_failed")? = Some(VerifiedInstaller {
            path,
            sha256: expected,
            size: release.installer.size,
            kind,
        });
        Ok(DownloadedUpdate {
            version: release.version,
            filename: release.installer.name,
        })
    })
    .await
    .map_err(|_| "download_failed".to_owned())?
}
#[tauri::command]
pub async fn install_app_update(app: tauri::AppHandle) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if crate::chat::has_active_processes(&app)
            || !app
                .state::<crate::state::PtyKillerMap>()
                .lock()
                .map_err(|_| "update_busy")?
                .is_empty()
            || !app
                .state::<crate::state::ProcessMap>()
                .lock()
                .map_err(|_| "update_busy")?
                .is_empty()
        {
            return Err("update_busy".into());
        }
        let state = app.state::<AppUpdateState>();
        let mut saved = state
            .installer
            .lock()
            .map_err(|_| "installer_unavailable")?;
        let installer = saved.as_ref().ok_or("installer_unavailable")?;
        copy_verified(
            File::open(&installer.path).map_err(|_| "installer_unavailable")?,
            std::io::sink(),
            installer.size,
            &installer.sha256,
            installer.kind,
        )?;
        app.opener()
            .open_path(installer.path.to_string_lossy(), None::<&str>)
            .map_err(|_| "installer_launch_failed")?;
        saved.take();
        Ok(())
    })
    .await
    .map_err(|_| "installer_launch_failed".to_owned())?
}

#[cfg(test)]
#[path = "app_updates_tests.rs"]
mod tests;
