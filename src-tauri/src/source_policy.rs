//! Versioned, explicit context associations. This does not sandbox the provider's filesystem.
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Component, Path},
    sync::Mutex,
};

pub static WRITE: Mutex<()> = Mutex::new(());
const VERSION: u32 = 2;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Vault {
    pub id: String,
    pub name: String,
    pub path: String,
    pub mode: String,
    #[serde(default)]
    pub allowed_paths: Vec<String>,
}
impl Vault {
    pub fn allows(&self, path: &str) -> bool {
        let path = path.replace('\\', "/");
        safe_relative(&path)
            && (self.allowed_paths.is_empty()
                || self.allowed_paths.iter().any(|allowed| {
                    path == *allowed
                        || path
                            .strip_prefix(allowed)
                            .is_some_and(|tail| tail.starts_with('/'))
                }))
    }
}
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    #[serde(default)]
    pub source_ids: Vec<String>,
    #[serde(default)]
    pub personal_preferences: bool,
    #[serde(default)]
    pub memory_collection_ids: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCollection {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub record_ids: Vec<String>,
}
#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredConfig {
    #[serde(default)]
    pub schema_version: u32,
    #[serde(default)]
    pub revision: u64,
    // Retained for rollback and the older administration commands; never an implicit grant.
    #[serde(default)]
    pub source_path: String,
    #[serde(default)]
    pub projects: HashMap<String, String>,
    #[serde(default)]
    pub vaults: Vec<Vault>,
    #[serde(default)]
    pub project_selections: HashMap<String, Selection>,
    #[serde(default)]
    pub conversation_selections: HashMap<String, Selection>,
    #[serde(default)]
    pub memory_collections: Vec<MemoryCollection>,
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Policy {
    pub schema_version: u32,
    pub revision: u64,
    pub project_key: Option<String>,
    pub session_id: Option<String>,
    pub inherit_project: bool,
    pub selection: Selection,
    pub vaults: Vec<Vault>,
    pub selected_sources: Vec<Vault>,
    pub memory_collections: Vec<MemoryCollection>,
    pub missing_source_ids: Vec<String>,
    pub migration_backup: Option<String>,
}
pub fn session_key(session: &str) -> &str {
    for prefix in ["codex:", "claude-code:", "gemini:"] {
        if let Some(value) = session.strip_prefix(prefix) {
            return value;
        }
    }
    session
}
pub fn conversation_key(project: &str, session: &str) -> String {
    format!("{project}\0{}", session_key(session))
}
pub fn canonical_project(project: Option<&str>) -> Result<Option<String>, String> {
    project
        .filter(|v| !v.trim().is_empty())
        .map(|value| crate::shared_memory::project_key(Path::new(&crate::util::expand_path(value))))
        .transpose()
}
fn safe_relative(value: &str) -> bool {
    !value.is_empty()
        && !value.contains(':')
        && !Path::new(value).is_absolute()
        && !Path::new(value).components().any(|part| {
            matches!(
                part,
                Component::ParentDir | Component::RootDir | Component::Prefix(_)
            )
        })
}
fn stable_legacy_id(path: &str) -> String {
    use sha2::{Digest, Sha256};
    format!("vault-{:x}", Sha256::digest(path.as_bytes()))
}
fn migrate(stored: &mut StoredConfig) {
    if stored.schema_version >= VERSION {
        return;
    }
    let mut paths = stored.projects.values().cloned().collect::<Vec<_>>();
    if !stored.source_path.is_empty() {
        paths.push(stored.source_path.clone());
    }
    paths.sort();
    paths.dedup();
    for path in paths.into_iter().filter(|path| !path.is_empty()) {
        let id = stable_legacy_id(&path);
        if !stored.vaults.iter().any(|vault| vault.id == id) {
            let name = Path::new(&path)
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("Imported vault")
                .to_owned();
            stored.vaults.push(Vault {
                id,
                name,
                path,
                mode: "automatic".into(),
                allowed_paths: vec![],
            });
        }
    }
    // Existing explicit project roots remain associated. The legacy global source needs review.
    for (project, path) in &stored.projects {
        if !path.is_empty() {
            stored
                .project_selections
                .entry(project.clone())
                .or_insert_with(|| Selection {
                    source_ids: vec![stable_legacy_id(path)],
                    ..Default::default()
                });
        }
    }
    stored.schema_version = VERSION;
    stored.revision = stored.revision.saturating_add(1);
}
pub fn load(path: &Path) -> Result<StoredConfig, String> {
    let _guard = WRITE.lock().map_err(|e| e.to_string())?;
    let original = match fs::read(path) {
        Ok(bytes) => Some(bytes),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.to_string()),
    };
    let mut stored: StoredConfig = original
        .as_deref()
        .map(serde_json::from_slice)
        .transpose()
        .map_err(|e| format!("Cannot read knowledge configuration: {e}"))?
        .unwrap_or_default();
    if stored.schema_version > VERSION {
        return Err("Knowledge configuration uses a newer schema".into());
    }
    if stored.schema_version < VERSION {
        // Stdio helpers only read associations. The GUI owns migration/writes, so an
        // already running helper cannot race the application's backup or rollback.
        if std::env::args_os()
            .nth(1)
            .is_some_and(|value| value == "--memory-mcp")
        {
            migrate(&mut stored);
            return Ok(stored);
        }
        if let Some(bytes) = &original {
            let backup = path.with_extension("v1.backup.json");
            if !backup.exists() {
                write_bytes(&backup, bytes)
                    .map_err(|e| format!("Cannot back up knowledge configuration: {e}"))?;
            }
            let verified = fs::read(&backup).map_err(|e| e.to_string())?;
            let _: StoredConfig = serde_json::from_slice(&verified).map_err(|_| {
                "Knowledge migration backup is incomplete or invalid; restore it before migrating"
            })?;
            if verified != *bytes {
                return Err("Knowledge migration backup does not match the legacy configuration; review the saved backup before migrating".into());
            }
        }
        migrate(&mut stored);
        write(path, &stored)?;
    }
    Ok(stored)
}
pub fn write(path: &Path, stored: &StoredConfig) -> Result<(), String> {
    write_bytes(
        path,
        &serde_json::to_vec_pretty(stored).map_err(|e| e.to_string())?,
    )
}
pub fn write_bytes(path: &Path, bytes: &[u8]) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let temporary = path.with_extension(format!("{}.pending.json", uuid::Uuid::new_v4()));
    fs::write(&temporary, bytes).map_err(|e| e.to_string())?;
    fs::OpenOptions::new()
        .write(true)
        .open(&temporary)
        .and_then(|file| file.sync_all())
        .map_err(|e| e.to_string())?;
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}
pub fn update(
    path: &Path,
    mutation: impl FnOnce(&mut StoredConfig) -> Result<(), String>,
) -> Result<(), String> {
    // Load may migrate under its own lock; then reopen while holding the writer lock.
    load(path)?;
    let _guard = WRITE.lock().map_err(|e| e.to_string())?;
    let mut stored: StoredConfig =
        serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    mutation(&mut stored)?;
    stored.revision = stored
        .revision
        .checked_add(1)
        .ok_or("Policy revision exhausted")?;
    write(path, &stored)
}
pub fn resolve(
    path: &Path,
    project: Option<&str>,
    session: Option<&str>,
) -> Result<Policy, String> {
    let stored = load(path)?;
    let project = canonical_project(project)?;
    let custom = project
        .as_deref()
        .zip(session)
        .and_then(|(project, session)| {
            stored
                .conversation_selections
                .get(&conversation_key(project, session))
        });
    let selection = custom
        .or_else(|| {
            project
                .as_deref()
                .and_then(|project| stored.project_selections.get(project))
        })
        .cloned()
        .unwrap_or_default();
    let selected_sources = selection
        .source_ids
        .iter()
        .filter_map(|id| stored.vaults.iter().find(|vault| vault.id == *id).cloned())
        .collect::<Vec<_>>();
    let missing_source_ids = selection
        .source_ids
        .iter()
        .filter(|id| !stored.vaults.iter().any(|vault| vault.id == **id))
        .cloned()
        .collect::<Vec<_>>();
    // Effective version: unrelated catalog/project changes must not invalidate this chat.
    // Restrict to 53 bits because this revision crosses the JavaScript JSON boundary.
    use sha2::{Digest, Sha256};
    let selected_collections = stored
        .memory_collections
        .iter()
        .filter(|collection| selection.memory_collection_ids.contains(&collection.id))
        .collect::<Vec<_>>();
    let payload = serde_json::to_vec(&serde_json::json!([
        &project,
        custom.is_none(),
        &selection,
        &selected_sources,
        selected_collections
    ]))
    .map_err(|e| e.to_string())?;
    let digest = Sha256::digest(payload);
    let revision = u64::from_be_bytes(digest[..8].try_into().unwrap()) & ((1_u64 << 53) - 1);
    let backup = path.with_extension("v1.backup.json");
    Ok(Policy {
        schema_version: VERSION,
        revision,
        project_key: project,
        session_id: session.map(session_key).map(str::to_owned),
        inherit_project: custom.is_none(),
        selection,
        vaults: stored.vaults,
        selected_sources,
        memory_collections: stored.memory_collections,
        missing_source_ids,
        migration_backup: backup
            .exists()
            .then(|| backup.to_string_lossy().into_owned()),
    })
}
pub fn validate_selection(stored: &StoredConfig, selection: &mut Selection) -> Result<(), String> {
    let mut seen = HashSet::new();
    selection.source_ids.retain(|id| seen.insert(id.clone()));
    seen.clear();
    selection
        .memory_collection_ids
        .retain(|id| seen.insert(id.clone()));
    if selection
        .source_ids
        .iter()
        .any(|id| !stored.vaults.iter().any(|vault| &vault.id == id))
    {
        return Err("Unknown vault ID".into());
    }
    if selection.memory_collection_ids.iter().any(|id| {
        !stored
            .memory_collections
            .iter()
            .any(|collection| &collection.id == id)
    }) {
        return Err("Unknown memory collection ID".into());
    }
    Ok(())
}
pub fn validate_vault(vault: &mut Vault) -> Result<(), String> {
    if vault.id.is_empty() {
        vault.id = uuid::Uuid::new_v4().to_string();
    }
    if vault.id.len() > 150 || vault.name.trim().is_empty() || vault.name.len() > 200 {
        return Err("Vault needs a valid ID and name".into());
    }
    if !matches!(vault.mode.as_str(), "disabled" | "query" | "automatic") {
        return Err("Invalid vault mode".into());
    }
    let root = fs::canonicalize(crate::util::expand_path(vault.path.trim()))
        .map_err(|e| format!("Cannot open knowledge folder: {e}"))?;
    if !root.is_dir() {
        return Err("Knowledge source must be a folder".into());
    }
    let normalized = root.to_string_lossy();
    vault.path = if let Some(network) = normalized.strip_prefix(r"\\?\UNC\") {
        format!(r"\\{network}")
    } else {
        normalized
            .strip_prefix(r"\\?\")
            .unwrap_or(&normalized)
            .into()
    };
    vault.name = vault.name.trim().into();
    for path in &mut vault.allowed_paths {
        let relative = path.trim().replace('\\', "/");
        if !safe_relative(&relative) {
            return Err("Allowed paths must be relative folders or notes within the vault".into());
        }
        *path = relative
            .split('/')
            .filter(|component| !component.is_empty() && *component != ".")
            .collect::<Vec<_>>()
            .join("/");
        if path.is_empty() {
            return Err("Leave restrictions empty to permit the entire vault".into());
        }
        // Resolve existing restrictions to prevent a junction from granting another root.
        let target = root.join(&*path);
        if target.exists()
            && !fs::canonicalize(target)
                .map_err(|e| e.to_string())?
                .starts_with(&root)
        {
            return Err("Restriction escaped vault root".into());
        }
    }
    Ok(())
}
impl Policy {
    pub fn sources(&self, automatic: bool) -> Vec<&Vault> {
        self.selected_sources
            .iter()
            .filter(|vault| vault.mode == "automatic" || (!automatic && vault.mode == "query"))
            .collect()
    }
    pub fn allows_memory(
        &self,
        engine: &crate::shared_memory::Engine,
        record: &crate::shared_memory::MemoryRecord,
    ) -> Result<bool, String> {
        // Project reads have already passed the Engine's UUID-based ownership/applicability check.
        if record.scope != "global" {
            return Ok(true);
        }
        let metadata = engine.metadata(crate::shared_memory::GLOBAL_MEMORY_KEY, &record.id)?;
        if metadata.state != "active" || metadata.feedback == "wrong" {
            return Ok(false);
        }
        let explicitly_collected = self.memory_collections.iter().any(|collection| {
            self.selection
                .memory_collection_ids
                .contains(&collection.id)
                && collection.record_ids.contains(&record.id)
        });
        let personal = self.selection.personal_preferences
            && record.kind == "fact"
            && record.verification == "user-confirmed"
            && metadata.category == "preference"
            && metadata.applies_to.is_empty()
            && metadata.universal_approved;
        Ok(explicitly_collected || personal)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (std::path::PathBuf, std::path::PathBuf, String) {
        let root = std::env::temp_dir().join(format!("agentdeck-policy-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("one/allowed")).unwrap();
        fs::create_dir_all(root.join("two")).unwrap();
        let project = canonical_project(Some(root.to_str().unwrap()))
            .unwrap()
            .unwrap();
        let config = root.join("knowledge.json");
        (root, config, project)
    }
    fn vault(
        root: &Path,
        id: &str,
        directory: &str,
        mode: &str,
        allowed_paths: Vec<String>,
    ) -> Vault {
        Vault {
            id: id.into(),
            name: format!("Free name {id}"),
            path: root.join(directory).to_string_lossy().into_owned(),
            mode: mode.into(),
            allowed_paths,
        }
    }
    #[test]
    fn migration_is_backed_up_idempotent_and_never_grants_legacy_global() {
        let (root, config, project) = fixture();
        let note = root.join("one/unchanged.md");
        fs::write(&note, "original bytes\n").unwrap();
        let original = serde_json::json!({"sourcePath":root.join("one"), "projects":{&project:root.join("two")}}).to_string();
        fs::write(&config, original.as_bytes()).unwrap();
        let first = resolve(&config, Some(root.to_str().unwrap()), Some("chat")).unwrap();
        assert_eq!(first.vaults.len(), 2);
        assert_eq!(first.selected_sources.len(), 1);
        assert_eq!(
            first.selected_sources[0].path,
            root.join("two").to_string_lossy()
        );
        assert!(!first.selection.personal_preferences);
        assert_eq!(
            fs::read(config.with_extension("v1.backup.json")).unwrap(),
            original.as_bytes()
        );
        let bytes = fs::read(&config).unwrap();
        let second = resolve(&config, Some(root.to_str().unwrap()), Some("chat")).unwrap();
        assert_eq!(second.revision, first.revision);
        assert_eq!(fs::read(&config).unwrap(), bytes);
        assert_eq!(fs::read(&note).unwrap(), b"original bytes\n");
        assert!(resolve(&config, None, None)
            .unwrap()
            .selected_sources
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn custom_empty_is_no_sources_and_inheritance_changes_only_inheriting_chats() {
        let (root, config, project) = fixture();
        update(&config, |stored| {
            stored.vaults = vec![
                vault(&root, "a", "one", "automatic", vec![]),
                vault(&root, "b", "two", "automatic", vec![]),
            ];
            stored.project_selections.insert(
                project.clone(),
                Selection {
                    source_ids: vec!["a".into()],
                    ..Default::default()
                },
            );
            stored
                .conversation_selections
                .insert(conversation_key(&project, "empty"), Selection::default());
            Ok(())
        })
        .unwrap();
        assert_eq!(
            resolve(&config, Some(root.to_str().unwrap()), Some("inherit"))
                .unwrap()
                .sources(true)[0]
                .id,
            "a"
        );
        let empty = resolve(&config, Some(root.to_str().unwrap()), Some("codex:empty")).unwrap();
        assert!(!empty.inherit_project);
        assert!(empty.sources(false).is_empty());
        update(&config, |stored| {
            stored
                .project_selections
                .get_mut(&project)
                .unwrap()
                .source_ids = vec!["b".into()];
            Ok(())
        })
        .unwrap();
        assert_eq!(
            resolve(&config, Some(root.to_str().unwrap()), Some("inherit"))
                .unwrap()
                .sources(true)[0]
                .id,
            "b"
        );
        assert!(
            resolve(&config, Some(root.to_str().unwrap()), Some("empty"))
                .unwrap()
                .sources(false)
                .is_empty()
        );
        assert_ne!(
            resolve(&config, Some(root.to_str().unwrap()), Some("inherit"))
                .unwrap()
                .revision,
            empty.revision
        );
        assert_eq!(
            resolve(&config, Some(root.to_str().unwrap()), Some("empty"))
                .unwrap()
                .revision,
            empty.revision
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn source_ids_distinguish_matching_paths_and_known_id_cannot_bypass_selection() {
        let (root, config, project) = fixture();
        fs::write(root.join("one/same.md"), "# Match\ncommon alpha evidence").unwrap();
        fs::write(root.join("two/same.md"), "# Match\ncommon beta evidence").unwrap();
        update(&config, |stored| {
            stored.vaults = vec![
                vault(&root, "a", "one", "automatic", vec![]),
                vault(&root, "b", "two", "automatic", vec![]),
            ];
            stored.project_selections.insert(
                project.clone(),
                Selection {
                    source_ids: vec!["a".into(), "b".into()],
                    ..Default::default()
                },
            );
            Ok(())
        })
        .unwrap();
        let both = crate::knowledge::search_documents_policy(
            &config,
            Some(root.to_str().unwrap()),
            Some("chat"),
            "common",
            true,
        )
        .unwrap();
        assert_eq!(both.hits.len(), 2);
        assert_ne!(both.hits[0].id, both.hits[1].id);
        let denied = both
            .hits
            .iter()
            .find(|hit| hit.scope == "b")
            .unwrap()
            .id
            .clone();
        update(&config, |stored| {
            stored
                .project_selections
                .get_mut(&project)
                .unwrap()
                .source_ids = vec!["a".into()];
            Ok(())
        })
        .unwrap();
        let selected = crate::knowledge::search_documents_policy(
            &config,
            Some(root.to_str().unwrap()),
            Some("chat"),
            "common",
            true,
        )
        .unwrap();
        assert_eq!(selected.hits.len(), 1);
        assert_eq!(selected.hits[0].scope, "a");
        assert!(crate::knowledge::read_document_policy(
            &config,
            Some(root.to_str().unwrap()),
            Some("chat"),
            &denied,
            0,
            2000
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn modes_and_restrictions_apply_to_auto_queries_wikilinks_direct_reads_and_cached_indexes() {
        let (root, config, project) = fixture();
        fs::write(
            root.join("one/allowed/seed.md"),
            "# Seed\ncommon [[private]]",
        )
        .unwrap();
        fs::write(
            root.join("one/private.md"),
            "# Private\ncommon confidential evidence",
        )
        .unwrap();
        update(&config, |stored| {
            stored.vaults = vec![vault(&root, "a", "one", "query", vec!["allowed".into()])];
            stored.project_selections.insert(
                project.clone(),
                Selection {
                    source_ids: vec!["a".into()],
                    ..Default::default()
                },
            );
            Ok(())
        })
        .unwrap();
        assert!(crate::knowledge::search_documents_policy(
            &config,
            Some(root.to_str().unwrap()),
            Some("chat"),
            "common",
            true
        )
        .unwrap()
        .hits
        .is_empty());
        let query = crate::knowledge::search_documents_policy(
            &config,
            Some(root.to_str().unwrap()),
            Some("chat"),
            "common",
            false,
        )
        .unwrap();
        assert_eq!(query.hits.len(), 1);
        assert_eq!(query.hits[0].path, "allowed/seed.md");
        let private = "doc:[\"a\",\"private.md\"]";
        assert!(crate::knowledge::read_document_policy(
            &config,
            Some(root.to_str().unwrap()),
            Some("chat"),
            private,
            0,
            2000
        )
        .is_err());
        assert!(crate::knowledge::read_document_policy(
            &config,
            Some(root.to_str().unwrap()),
            Some("chat"),
            &query.hits[0].id,
            0,
            2000
        )
        .unwrap()
        .contains("common"));
        update(&config, |stored| {
            stored.vaults[0].mode = "disabled".into();
            Ok(())
        })
        .unwrap();
        assert!(crate::knowledge::read_document_policy(
            &config,
            Some(root.to_str().unwrap()),
            Some("chat"),
            &query.hits[0].id,
            0,
            2000
        )
        .is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn names_do_not_grant_sources_and_removing_catalog_item_leaves_missing_diagnostic() {
        let (root, config, project) = fixture();
        update(&config, |stored| {
            stored.vaults = vec![vault(&root, "a", "one", "automatic", vec![])];
            stored.project_selections.insert(
                project.clone(),
                Selection {
                    source_ids: vec!["a".into()],
                    ..Default::default()
                },
            );
            Ok(())
        })
        .unwrap();
        update(&config, |stored| {
            stored.vaults[0].name = "Renamed arbitrarily".into();
            Ok(())
        })
        .unwrap();
        assert_eq!(
            resolve(&config, Some(root.to_str().unwrap()), None)
                .unwrap()
                .selected_sources[0]
                .id,
            "a"
        );
        update(&config, |stored| {
            stored.vaults.clear();
            Ok(())
        })
        .unwrap();
        let policy = resolve(&config, Some(root.to_str().unwrap()), None).unwrap();
        assert!(policy.sources(false).is_empty());
        assert_eq!(policy.missing_source_ids, vec!["a"]);
        assert!(root.join("one").is_dir());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn personal_and_shared_collections_require_independent_explicit_opt_in() {
        let (root, config, project) = fixture();
        let engine = crate::shared_memory::Engine::open(&root).unwrap();
        let sqlite_project = engine
            .register_project(root.to_str().unwrap(), None)
            .unwrap();
        engine
            .record_event(
                &sqlite_project,
                "session",
                "codex",
                &crate::shared_memory::MemoryEvent {
                    id: "preference-evidence".into(),
                    kind: "prompt".into(),
                    title: "Preference".into(),
                    summary: "Por padrão prefiro pnpm em todos os meus projetos".into(),
                    files: vec![],
                    branch: String::new(),
                },
            )
            .unwrap();
        let candidate = engine.profile_candidates().unwrap().remove(0);
        let personal = engine
            .review_profile_for_scope(&candidate.id, true, true)
            .unwrap()
            .unwrap();
        let captured = engine
            .save(
                crate::shared_memory::GLOBAL_MEMORY_KEY,
                &crate::shared_memory::MemoryDraft {
                    id: None,
                    title: "Other".into(),
                    content: "Project specific fact".into(),
                    kind: "fact".into(),
                    pinned: true,
                },
                None,
                None,
            )
            .unwrap();
        assert!(!resolve(&config, Some(root.to_str().unwrap()), None)
            .unwrap()
            .allows_memory(&engine, &personal)
            .unwrap());
        update(&config, |stored| {
            stored.project_selections.insert(
                project.clone(),
                Selection {
                    personal_preferences: true,
                    ..Default::default()
                },
            );
            Ok(())
        })
        .unwrap();
        let policy = resolve(&config, Some(root.to_str().unwrap()), None).unwrap();
        assert!(policy.allows_memory(&engine, &personal).unwrap());
        assert!(!policy.allows_memory(&engine, &captured).unwrap());
        update(&config, |stored| {
            stored.memory_collections.push(MemoryCollection {
                id: "chosen".into(),
                name: "Arbitrary shared scope".into(),
                record_ids: vec![captured.id.clone()],
            });
            stored
                .project_selections
                .get_mut(&project)
                .unwrap()
                .memory_collection_ids
                .push("chosen".into());
            Ok(())
        })
        .unwrap();
        assert!(resolve(&config, Some(root.to_str().unwrap()), None)
            .unwrap()
            .allows_memory(&engine, &captured)
            .unwrap());
        assert!(
            !resolve(&config, Some(root.join("two").to_str().unwrap()), None)
                .unwrap()
                .allows_memory(&engine, &personal)
                .unwrap()
        );
        drop(engine);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn invalid_or_interrupted_migration_does_not_overwrite_original_and_failed_mutation_is_atomic()
    {
        let (root, config, _) = fixture();
        fs::write(&config, b"{interrupted").unwrap();
        assert!(load(&config).is_err());
        assert_eq!(fs::read(&config).unwrap(), b"{interrupted");
        fs::write(&config, b"{}").unwrap();
        load(&config).unwrap();
        let before = fs::read(&config).unwrap();
        assert!(update(&config, |stored| {
            stored.source_path = "changed".into();
            Err("validation failed".into())
        })
        .is_err());
        assert_eq!(fs::read(&config).unwrap(), before);
        let mut invalid = vault(&root, "a", "one", "automatic", vec!["../two".into()]);
        assert!(validate_vault(&mut invalid).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn interrupted_or_mismatched_existing_backup_blocks_migration_without_overwriting_evidence() {
        let (root, config, _) = fixture();
        let original = serde_json::json!({"sourcePath":root.join("one")}).to_string();
        fs::write(&config, original.as_bytes()).unwrap();
        let backup = config.with_extension("v1.backup.json");
        fs::write(&backup, b"{partial").unwrap();
        assert!(load(&config).is_err());
        assert_eq!(fs::read(&backup).unwrap(), b"{partial");
        assert_eq!(fs::read(&config).unwrap(), original.as_bytes());
        fs::write(&backup, b"{}").unwrap();
        assert!(load(&config).is_err());
        assert_eq!(fs::read(&config).unwrap(), original.as_bytes());
        fs::write(&backup, original.as_bytes()).unwrap();
        assert_eq!(load(&config).unwrap().schema_version, 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn approving_a_general_preference_does_not_confirm_universal_scope_implicitly() {
        let (root, config, project) = fixture();
        let engine = crate::shared_memory::Engine::open(&root).unwrap();
        let owner = engine
            .register_project(root.to_str().unwrap(), None)
            .unwrap();
        engine
            .record_event(
                &owner,
                "scope-test",
                "codex",
                &crate::shared_memory::MemoryEvent {
                    id: "scoped-evidence".into(),
                    kind: "prompt".into(),
                    title: "Preference".into(),
                    summary: "Por padrão prefiro pnpm em todos os meus projetos".into(),
                    files: vec![],
                    branch: String::new(),
                },
            )
            .unwrap();
        let candidate = engine.profile_candidates().unwrap().remove(0);
        let scoped = engine
            .review_profile_for_scope(&candidate.id, true, false)
            .unwrap()
            .unwrap();
        engine
            .set_metadata(
                crate::shared_memory::GLOBAL_MEMORY_KEY,
                &scoped.id,
                &crate::shared_memory::MemoryMetadata {
                    category: "preference".into(),
                    ..Default::default()
                },
            )
            .unwrap();
        update(&config, |stored| {
            stored.project_selections.insert(
                project.clone(),
                Selection {
                    personal_preferences: true,
                    ..Default::default()
                },
            );
            Ok(())
        })
        .unwrap();
        assert!(!engine.universal_preference_confirmed(&scoped.id).unwrap());
        assert!(!resolve(&config, Some(root.to_str().unwrap()), None)
            .unwrap()
            .allows_memory(&engine, &scoped)
            .unwrap());
        drop(engine);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn restricted_notes_are_filtered_before_ranking_limits() {
        let (root, config, project) = fixture();
        for index in 0..12 {
            fs::write(
                root.join(format!("one/hidden-{index}.md")),
                format!("# common common common {index}\n{}", "common ".repeat(40)),
            )
            .unwrap();
        }
        fs::write(
            root.join("one/allowed/target.md"),
            "# Target\ncommon selected evidence",
        )
        .unwrap();
        update(&config, |stored| {
            stored.vaults.push(vault(
                &root,
                "a",
                "one",
                "automatic",
                vec!["allowed".into()],
            ));
            stored.project_selections.insert(
                project,
                Selection {
                    source_ids: vec!["a".into()],
                    ..Default::default()
                },
            );
            Ok(())
        })
        .unwrap();
        let found = crate::knowledge::search_documents_policy(
            &config,
            Some(root.to_str().unwrap()),
            Some("chat"),
            "common",
            true,
        )
        .unwrap();
        assert_eq!(found.hits.len(), 1);
        assert_eq!(found.hits[0].path, "allowed/target.md");
        fs::remove_dir_all(root).unwrap();
    }
}
