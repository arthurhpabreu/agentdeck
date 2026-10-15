//! Read logical sizes without traversing links, and remove only verified build caches.
use crate::util::background_command;
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Default)]
pub(super) struct StorageSummary {
    pub size_bytes: u64,
    pub reclaimable_bytes: u64,
    pub cache_paths: Vec<String>,
    pub error: Option<String>,
}

struct Candidate {
    path: PathBuf,
    bytes: u64,
}

pub(super) fn is_link(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return true;
        }
    }
    false
}

/// Check the spelling supplied by Git before canonicalization can conceal a junction.
pub(super) fn ensure_plain_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() {
        return Err("Worktree path must be absolute".into());
    }
    for ancestor in path.ancestors() {
        let metadata = fs::symlink_metadata(ancestor)
            .map_err(|error| format!("{}: {error}", ancestor.display()))?;
        if is_link(&metadata) {
            return Err(format!(
                "Linked paths are preserved: {}",
                ancestor.display()
            ));
        }
    }
    Ok(())
}

fn git(root: &Path, args: &[&str]) -> Result<std::process::Output, String> {
    background_command("git")
        .current_dir(root)
        .args(args)
        .output()
        .map_err(|error| error.to_string())
}

fn tracked_paths(root: &Path) -> Result<Vec<String>, String> {
    let output = git(root, &["ls-files", "--cached", "--full-name", "-z"])?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().into());
    }
    Ok(String::from_utf8_lossy(&output.stdout)
        .split('\0')
        .filter(|path| !path.is_empty())
        .map(str::to_owned)
        .collect())
}

fn relative_path(root: &Path, path: &Path) -> Result<String, String> {
    let relative = path
        .strip_prefix(root)
        .map_err(|_| "Cache escaped worktree")?;
    if relative.as_os_str().is_empty()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("Cache escaped worktree".into());
    }
    let text = relative.to_str().ok_or("Cache path is not valid Unicode")?;
    // A backslash is a valid filename character on Unix, not a separator.
    Ok(if cfg!(windows) {
        text.replace('\\', "/")
    } else {
        text.to_owned()
    })
}

fn is_tracked(relative: &str, tracked: &[String]) -> bool {
    // macOS can normalize Unicode differently from Git's index. Preserve nested
    // cache paths when a text comparison cannot establish that they are untracked.
    if cfg!(target_os = "macos") && !relative.is_ascii() {
        return true;
    }
    // macOS also commonly uses a case-insensitive filesystem. Conservatively
    // preserve differently cased index entries on every OS, including Linux.
    let relative = relative.to_ascii_lowercase();
    let directory = format!("{relative}/");
    tracked.iter().any(|path| {
        let path = path.to_ascii_lowercase();
        path == relative
            || path.starts_with(&directory)
            || relative.starts_with(&format!("{path}/"))
    })
}

fn has_manifest(path: &Path) -> bool {
    let manifest = match path.file_name().and_then(|name| name.to_str()) {
        Some("node_modules") => "package.json",
        Some("target") => "Cargo.toml",
        _ => return false,
    };
    path.parent()
        .and_then(|parent| fs::symlink_metadata(parent.join(manifest)).ok())
        .is_some_and(|metadata| metadata.is_file() && !is_link(&metadata))
}

fn protected_ancestor(root: &Path, path: &Path) -> bool {
    let mut ancestor = path.parent();
    while let Some(parent) = ancestor {
        if parent == root {
            break;
        }
        if matches!(
            parent.file_name().and_then(|name| name.to_str()),
            Some("node_modules" | "target")
        ) || fs::symlink_metadata(parent.join(".git")).is_ok()
        {
            return true;
        }
        ancestor = parent.parent();
    }
    false
}

fn is_ignored(root: &Path, relative: &str) -> Result<bool, String> {
    let directory = format!("{relative}/");
    let output = git(
        root,
        &["check-ignore", "--quiet", "--no-index", "--", &directory],
    )?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => Err(String::from_utf8_lossy(&output.stderr).trim().into()),
    }
}

fn note(errors: &mut Vec<String>, message: String) {
    if errors.len() < 4 {
        errors.push(message);
    }
}

/// A false second value means this tree cannot be deleted as a cache. Links are
/// never traversed, including Windows junctions whose file type reports a directory.
fn walk(path: &Path, candidates: &mut Vec<Candidate>, errors: &mut Vec<String>) -> (u64, bool) {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            note(errors, format!("{}: {error}", path.display()));
            return (0, false);
        }
    };
    if is_link(&metadata) {
        return (0, false);
    }
    if path.file_name().is_some_and(|name| name == ".git") {
        if metadata.is_file() {
            return (metadata.len(), false);
        }
        note(
            errors,
            format!(
                "Nested Git metadata excluded from measurement: {}",
                path.display()
            ),
        );
        return (0, false);
    }
    if metadata.is_file() {
        return (metadata.len(), true);
    }
    if !metadata.is_dir() {
        return (0, false);
    }
    let entries = match fs::read_dir(path) {
        Ok(entries) => entries,
        Err(error) => {
            note(errors, format!("{}: {error}", path.display()));
            return (0, false);
        }
    };
    let mut size = 0u64;
    let mut plain = true;
    for entry in entries {
        match entry {
            Ok(entry) => {
                let (bytes, safe) = walk(&entry.path(), candidates, errors);
                size = size.saturating_add(bytes);
                plain &= safe;
            }
            Err(error) => {
                plain = false;
                note(errors, format!("{}: {error}", path.display()));
            }
        }
    }
    if has_manifest(path) {
        if plain {
            candidates.push(Candidate {
                path: path.into(),
                bytes: size,
            });
        } else {
            note(
                errors,
                format!(
                    "Cache contains protected, linked or unreadable files and was preserved: {}",
                    path.display()
                ),
            );
        }
    }
    (size, plain)
}

pub(super) fn inspect(root: &Path) -> StorageSummary {
    let mut summary = StorageSummary::default();
    if let Err(error) = ensure_plain_path(root) {
        summary.error = Some(error);
        return summary;
    }
    let mut errors = Vec::new();
    let mut candidates = Vec::new();
    summary.size_bytes = walk(root, &mut candidates, &mut errors).0;
    match tracked_paths(root) {
        Ok(tracked) => {
            // Select outermost verified caches so nested folders are never counted twice.
            candidates.sort_by_key(|candidate| candidate.path.components().count());
            let mut selected: Vec<PathBuf> = Vec::new();
            for candidate in candidates {
                if protected_ancestor(root, &candidate.path)
                    || selected
                        .iter()
                        .any(|parent| candidate.path.starts_with(parent))
                {
                    continue;
                }
                let relative = match relative_path(root, &candidate.path) {
                    Ok(relative) => relative,
                    Err(error) => {
                        note(&mut errors, error);
                        continue;
                    }
                };
                if is_tracked(&relative, &tracked) {
                    continue;
                }
                match is_ignored(root, &relative) {
                    Ok(true) => {
                        summary.reclaimable_bytes =
                            summary.reclaimable_bytes.saturating_add(candidate.bytes);
                        summary.cache_paths.push(relative);
                        selected.push(candidate.path);
                    }
                    Ok(false) => {}
                    Err(error) => note(&mut errors, error),
                }
            }
        }
        Err(error) => note(&mut errors, error),
    }
    if !errors.is_empty() {
        summary.error = Some(errors.join("; "));
    }
    summary
}

fn validate_cache(root: &Path, path: &Path, tracked: &[String]) -> Result<(), String> {
    ensure_plain_path(path)?;
    let relative = relative_path(root, path)?;
    if protected_ancestor(root, path)
        || !has_manifest(path)
        || is_tracked(&relative, tracked)
        || !is_ignored(root, &relative)?
    {
        return Err(format!(
            "Folder is not an ignored, untracked build cache: {relative}"
        ));
    }
    let mut errors = Vec::new();
    if !walk(path, &mut Vec::new(), &mut errors).1 {
        return Err(format!(
            "Cache contains linked or unreadable files: {relative}"
        ));
    }
    Ok(())
}

/// Remove through checked nodes rather than relying on recursive link traversal.
fn remove_plain_tree(path: &Path) -> Result<u64, String> {
    ensure_plain_path(path)?;
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.is_file() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
        return Ok(metadata.len());
    }
    if !metadata.is_dir() {
        return Err(format!("Unsupported cache entry: {}", path.display()));
    }
    let mut removed = 0u64;
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        removed = removed.saturating_add(remove_plain_tree(&entry.path())?);
    }
    fs::remove_dir(path).map_err(|error| error.to_string())?;
    Ok(removed)
}

/// The caller validates registration, namespace, HEAD, locks and running sessions.
/// All selected targets are validated before the first filesystem mutation.
pub(super) fn clean_with_guard(
    root: &Path,
    cache_paths: &[String],
    before_mutation: impl Fn() -> Result<(), String>,
) -> Result<u64, String> {
    ensure_plain_path(root)?;
    let tracked = tracked_paths(root)?;
    let mut targets = Vec::new();
    for relative in cache_paths {
        let path = root.join(relative);
        validate_cache(root, &path, &tracked)?;
        targets.push(path);
    }
    let mut removed = 0u64;
    for path in targets {
        // Catch a new index entry or linked descendant immediately before deletion.
        validate_cache(root, &path, &tracked_paths(root)?)?;
        before_mutation()?;
        removed = removed.saturating_add(remove_plain_tree(&path)?);
    }
    Ok(removed)
}

#[cfg(test)]
pub(super) fn clean(root: &Path, cache_paths: &[String]) -> Result<u64, String> {
    clean_with_guard(root, cache_paths, || Ok(()))
}
