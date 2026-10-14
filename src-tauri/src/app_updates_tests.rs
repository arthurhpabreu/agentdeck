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
    for tag in [
        "v0.7.0-beta",
        "v0.7",
        "../0.7.0",
        "v0.7.0/evil",
        "v0.7.-1",
        "v0.07.0",
    ] {
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
fn downloads_require_exact_official_assets_and_checksums_for_supported_installers() {
    for kind in [InstallerKind::Nsis, InstallerKind::Msi, InstallerKind::Dmg] {
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
fn native_platforms_select_shared_macos_artifacts_without_changing_windows_formats() {
    for (os, arch) in [
        ("windows", "x86_64"),
        ("macos", "x86_64"),
        ("macos", "aarch64"),
    ] {
        assert!(supported_platform(os, arch));
    }
    for (os, arch) in [
        ("windows", "aarch64"),
        ("linux", "x86_64"),
        ("macos", "powerpc"),
    ] {
        assert!(!supported_platform(os, arch));
    }
    assert_eq!(
        InstallerKind::Dmg.filename("0.7.0"),
        "Agentdeck_0.7.0_universal.dmg"
    );
    assert_eq!(InstallerKind::Dmg.label(), "dmg");
    assert_eq!(
        InstallerKind::Nsis.filename("0.7.0"),
        "Agentdeck_0.7.0_x64-setup.exe"
    );
    assert_eq!(
        InstallerKind::Msi.filename("0.7.0"),
        "Agentdeck_0.7.0_x64_en-US.msi"
    );
}

#[test]
fn macos_downloads_require_valid_udif_trailers_and_full_sha256() {
    let mut image = vec![0xa5; 80_000];
    let footer = image.len() - 512;
    image[footer..footer + 4].copy_from_slice(b"koly");
    image[footer + 4..footer + 8].copy_from_slice(&4u32.to_be_bytes());
    image[footer + 8..footer + 12].copy_from_slice(&512u32.to_be_bytes());
    let verify = |data: &[u8], digest: &str| {
        copy_verified(
            data,
            std::io::sink(),
            data.len() as u64,
            digest,
            InstallerKind::Dmg,
        )
    };
    let digest = format!("{:x}", Sha256::digest(&image));
    let mut output = Vec::new();
    copy_verified(
        image.as_slice(),
        &mut output,
        image.len() as u64,
        &digest,
        InstallerKind::Dmg,
    )
    .unwrap();
    assert_eq!(output, image);
    // Exercise network reads that split the UDIF trailer into small pieces.
    struct SmallReads<'a>(&'a [u8]);
    impl Read for SmallReads<'_> {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            let amount = self.0.len().min(buffer.len()).min(37);
            buffer[..amount].copy_from_slice(&self.0[..amount]);
            self.0 = &self.0[amount..];
            Ok(amount)
        }
    }
    copy_verified(
        SmallReads(&image),
        std::io::sink(),
        image.len() as u64,
        &digest,
        InstallerKind::Dmg,
    )
    .unwrap();
    let mut tampered = image.clone();
    tampered[1] ^= 1;
    assert!(verify(&tampered, &digest).is_err());
    for offset in [footer, footer + 4, footer + 8] {
        let mut malformed = image.clone();
        malformed[offset] ^= 1;
        assert!(verify(&malformed, &format!("{:x}", Sha256::digest(&malformed))).is_err());
    }
    let prefix_only = [b"koly".as_slice(), &[0; 508]].concat();
    assert!(verify(&prefix_only, &format!("{:x}", Sha256::digest(&prefix_only))).is_err());
    let short = b"koly";
    assert!(verify(short, &format!("{:x}", Sha256::digest(short))).is_err());
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
