use super::*;

#[test]
#[ignore = "Opt-in official GitHub release downloads; verifies both installers without opening or installing them"]
fn official_release_metadata_and_download_smoke() {
    let client = client(180).unwrap();
    for kind in [InstallerKind::Nsis, InstallerKind::Msi] {
        let release = select_release(latest_release(&client).unwrap(), "0.0.0", kind)
            .unwrap()
            .unwrap();
        let checksums = fetch_bounded(
            &client,
            &release.checksums.browser_download_url,
            MAX_CHECKSUM_BYTES,
        )
        .unwrap();
        let digest = checksum(
            std::str::from_utf8(&checksums)
                .unwrap()
                .trim_start_matches('\u{feff}'),
            &release.installer.name,
        )
        .unwrap();
        let response = client
            .get(&release.installer.browser_download_url)
            .send()
            .unwrap()
            .error_for_status()
            .unwrap();
        copy_verified(
            response,
            std::io::sink(),
            release.installer.size,
            &digest,
            kind,
        )
        .unwrap();
    }
}

fn release(tag: &str, kind: InstallerKind) -> Release {
    let filename = kind.filename(tag.trim_start_matches('v'));
    Release {
        tag_name: tag.into(),
        draft: false,
        prerelease: false,
        assets: [filename, "SHA256SUMS.txt".into()]
            .into_iter()
            .map(|name| Asset {
                browser_download_url: format!("{DOWNLOAD_ROOT}/{tag}/{name}"),
                name,
                size: 100,
            })
            .collect(),
    }
}

#[test]
fn stable_versions_compare_numerically_and_never_downgrade() {
    assert!(select_release(
        release("v0.6.10", InstallerKind::Nsis),
        "0.6.9",
        InstallerKind::Nsis
    )
    .unwrap()
    .is_some());
    for tag in ["v0.6.1", "v0.5.9"] {
        assert!(select_release(
            release(tag, InstallerKind::Nsis),
            "0.6.1",
            InstallerKind::Nsis
        )
        .unwrap()
        .is_none());
    }
    for tag in ["v0.7.0-beta", "v0.7", "../0.7.0", "v0.7.0/evil", "v0.7.-1"] {
        assert!(select_release(
            release(tag, InstallerKind::Nsis),
            "0.6.1",
            InstallerKind::Nsis
        )
        .is_err());
    }
    for flag in ["draft", "prerelease"] {
        let mut candidate = release("v0.7.0", InstallerKind::Nsis);
        candidate.draft = flag == "draft";
        candidate.prerelease = flag == "prerelease";
        assert!(select_release(candidate, "0.6.1", InstallerKind::Nsis).is_err());
    }
}
#[test]
fn downloads_require_exact_official_assets_and_checksums_for_both_installer_types() {
    for kind in [InstallerKind::Nsis, InstallerKind::Msi] {
        let selected = select_release(release("v0.7.0", kind), "0.6.1", kind)
            .unwrap()
            .unwrap();
        assert_eq!(selected.installer.name, kind.filename("0.7.0"));
        for url in [
            "https://example.com/installer.exe",
            "file:///installer.exe",
            "https://github.com/another/repo/releases/download/v0.7.0/installer.exe",
        ] {
            let mut candidate = release("v0.7.0", kind);
            candidate.assets[0].browser_download_url = url.into();
            assert!(select_release(candidate, "0.6.1", kind).is_err());
        }
        let mut candidate = release("v0.7.0", kind);
        candidate.assets.pop();
        assert!(select_release(candidate, "0.6.1", kind).is_err());
        let mut candidate = release("v0.7.0", kind);
        candidate.assets[0].size = MAX_INSTALLER_BYTES + 1;
        assert!(select_release(candidate, "0.6.1", kind).is_err());
    }
}
#[test]
fn checksum_selection_is_exact_and_rejects_ambiguous_or_invalid_entries() {
    let digest = "ab".repeat(32);
    assert_eq!(
        checksum(
            &format!(
                "{}  *setup.exe\n{}  LICENSE\n",
                digest.to_uppercase(),
                "cd".repeat(32)
            ),
            "setup.exe"
        )
        .unwrap(),
        digest
    );
    for text in [
        format!("{digest}  ../setup.exe"),
        "wrong setup.exe".into(),
        format!("{digest} setup.exe\n{digest} setup.exe"),
    ] {
        assert!(checksum(&text, "setup.exe").is_err());
    }
}
#[test]
fn installer_verification_rejects_tampering_incomplete_downloads_and_wrong_containers() {
    for kind in [InstallerKind::Nsis, InstallerKind::Msi] {
        let mut data = kind.magic().to_vec();
        data.extend_from_slice(b"Synthetic installer fixture");
        let digest = format!("{:x}", Sha256::digest(&data));
        let mut output = Vec::new();
        copy_verified(
            data.as_slice(),
            &mut output,
            data.len() as u64,
            &digest,
            kind,
        )
        .unwrap();
        assert_eq!(output, data);
        let mut changed = data.clone();
        *changed.last_mut().unwrap() ^= 1;
        assert!(copy_verified(
            changed.as_slice(),
            std::io::sink(),
            data.len() as u64,
            &digest,
            kind
        )
        .is_err());
        assert!(copy_verified(
            &data[..data.len() - 1],
            std::io::sink(),
            data.len() as u64,
            &digest,
            kind
        )
        .is_err());
        assert!(copy_verified(
            data.as_slice(),
            std::io::sink(),
            data.len() as u64 - 1,
            &digest,
            kind
        )
        .is_err());
        let html = b"<html>not an installer</html>";
        assert!(copy_verified(
            html.as_slice(),
            std::io::sink(),
            html.len() as u64,
            &format!("{:x}", Sha256::digest(html)),
            kind
        )
        .is_err());
    }
}
