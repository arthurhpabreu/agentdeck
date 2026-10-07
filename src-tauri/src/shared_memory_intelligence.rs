//! Durable identities, evidence-backed preferences, versions and reversible maintenance.
use super::*;
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub(super) fn migrate(connection: &Connection) -> Result<()> {
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |row| row.get(0))
        .map_err(db_error)?;
    if version >= 3 {
        return Ok(());
    }
    connection.execute_batch("BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS memory_projects (
            id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL DEFAULT '',stack TEXT NOT NULL DEFAULT '[]',
            repository_identity TEXT NOT NULL DEFAULT '',updated_at INTEGER NOT NULL,
            contribute INTEGER NOT NULL DEFAULT 1,consume INTEGER NOT NULL DEFAULT 1,
            discovery INTEGER NOT NULL DEFAULT 0,visible INTEGER NOT NULL DEFAULT 1
        );
        CREATE TABLE IF NOT EXISTS memory_project_paths (path TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES memory_projects(id));
        CREATE INDEX IF NOT EXISTS memory_project_path_owner ON memory_project_paths(project_id);
        CREATE TABLE IF NOT EXISTS memory_metadata (
            memory_id TEXT PRIMARY KEY REFERENCES memory_records(id) ON DELETE CASCADE,
            category TEXT NOT NULL DEFAULT '',applies_to TEXT NOT NULL DEFAULT '[]',state TEXT NOT NULL DEFAULT 'active',
            superseded_by TEXT,relations TEXT NOT NULL DEFAULT '{}',access_count INTEGER NOT NULL DEFAULT 0,
            last_accessed_at INTEGER NOT NULL DEFAULT 0,feedback TEXT NOT NULL DEFAULT '',archived_at INTEGER
        );
        CREATE TABLE IF NOT EXISTS memory_versions (
            memory_id TEXT NOT NULL REFERENCES memory_records(id) ON DELETE CASCADE,revision INTEGER NOT NULL,
            snapshot TEXT NOT NULL,recorded_at INTEGER NOT NULL,PRIMARY KEY(memory_id,revision)
        );
        CREATE TABLE IF NOT EXISTS memory_events (
            id TEXT PRIMARY KEY,project_key TEXT NOT NULL,session_id TEXT NOT NULL,provider TEXT NOT NULL,
            kind TEXT NOT NULL,title TEXT NOT NULL,summary TEXT NOT NULL,files TEXT NOT NULL,branch TEXT NOT NULL,
            observed_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS memory_event_session ON memory_events(project_key,provider,session_id,observed_at);
        CREATE TABLE IF NOT EXISTS memory_profile_candidates (
            id TEXT PRIMARY KEY,topic TEXT NOT NULL,statement TEXT NOT NULL,category TEXT NOT NULL,applies_to TEXT NOT NULL,
            general INTEGER NOT NULL DEFAULT 0,status TEXT NOT NULL DEFAULT 'candidate',record_id TEXT,updated_at INTEGER NOT NULL
        );
        CREATE UNIQUE INDEX IF NOT EXISTS memory_profile_statement ON memory_profile_candidates(topic,statement);
        CREATE TABLE IF NOT EXISTS memory_profile_evidence (
            candidate_id TEXT NOT NULL REFERENCES memory_profile_candidates(id) ON DELETE CASCADE,
            project_key TEXT NOT NULL,event_id TEXT NOT NULL,quote TEXT NOT NULL,observed_at INTEGER NOT NULL,
            PRIMARY KEY(candidate_id,project_key,event_id)
        );
        CREATE TABLE IF NOT EXISTS memory_export_targets (project_key TEXT PRIMARY KEY,directory TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS memory_forgotten_captures (project_key TEXT NOT NULL,fingerprint TEXT NOT NULL,PRIMARY KEY(project_key,fingerprint));
        CREATE TRIGGER IF NOT EXISTS memory_version_insert AFTER INSERT ON memory_records BEGIN
            INSERT INTO memory_versions(memory_id,revision,snapshot,recorded_at) VALUES(new.id,new.revision,
            json_object('id',new.id,'title',new.title,'content',new.content,'kind',new.kind,'sourceSessionId',new.source_session_id,
            'provider',new.provider,'updatedAt',new.updated_at,'revision',new.revision,'pinned',json(CASE WHEN new.pinned THEN 'true' ELSE 'false' END),
            'source',new.source,'verification',new.verification,'scope',CASE WHEN new.project_key='agentdeck:global' THEN 'global' ELSE 'project' END),new.updated_at);
        END;
        CREATE TRIGGER IF NOT EXISTS memory_version_update AFTER UPDATE ON memory_records WHEN new.revision<>old.revision BEGIN
            INSERT OR IGNORE INTO memory_versions(memory_id,revision,snapshot,recorded_at) VALUES(new.id,new.revision,
            json_object('id',new.id,'title',new.title,'content',new.content,'kind',new.kind,'sourceSessionId',new.source_session_id,
            'provider',new.provider,'updatedAt',new.updated_at,'revision',new.revision,'pinned',json(CASE WHEN new.pinned THEN 'true' ELSE 'false' END),
            'source',new.source,'verification',new.verification,'scope',CASE WHEN new.project_key='agentdeck:global' THEN 'global' ELSE 'project' END),new.updated_at);
        END;
        INSERT OR IGNORE INTO memory_versions(memory_id,revision,snapshot,recorded_at)
            SELECT id,revision,json_object('id',id,'title',title,'content',content,'kind',kind,'sourceSessionId',source_session_id,
            'provider',provider,'updatedAt',updated_at,'revision',revision,'pinned',json(CASE WHEN pinned THEN 'true' ELSE 'false' END),
            'source',source,'verification',verification,'scope',CASE WHEN project_key='agentdeck:global' THEN 'global' ELSE 'project' END),updated_at FROM memory_records;
        PRAGMA user_version=3;
        COMMIT;").map_err(db_error)
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntelligenceSettings {
    pub contribute: bool,
    pub consume: bool,
    pub discovery: bool,
    pub visible: bool,
}
impl Default for IntelligenceSettings {
    fn default() -> Self {
        Self {
            contribute: true,
            consume: true,
            discovery: false,
            visible: true,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogProject {
    pub id: String,
    pub name: String,
    pub description: String,
    pub stack: Vec<String>,
    pub paths: Vec<String>,
    pub repository_identity: String,
    pub updated_at: u64,
    pub record_count: usize,
    pub settings: IntelligenceSettings,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct MemoryMetadata {
    pub category: String,
    pub applies_to: Vec<String>,
    pub state: String,
    pub superseded_by: Option<String>,
    pub relations: HashMap<String, Vec<String>>,
    pub access_count: u64,
    pub last_accessed_at: u64,
    pub feedback: String,
}
impl Default for MemoryMetadata {
    fn default() -> Self {
        Self {
            category: String::new(),
            applies_to: Vec::new(),
            state: "active".into(),
            superseded_by: None,
            relations: HashMap::new(),
            access_count: 0,
            last_accessed_at: 0,
            feedback: String::new(),
        }
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryVersion {
    pub record: MemoryRecord,
    pub recorded_at: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryEvent {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub summary: String,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub branch: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileEvidence {
    pub project_key: String,
    pub event_id: String,
    pub quote: String,
    pub observed_at: u64,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileCandidate {
    pub id: String,
    pub topic: String,
    pub statement: String,
    pub category: String,
    pub applies_to: Vec<String>,
    pub general: bool,
    pub status: String,
    pub record_id: Option<String>,
    pub updated_at: u64,
    pub evidence: Vec<ProfileEvidence>,
    pub project_count: usize,
    pub eligible: bool,
}

pub(super) fn digest(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}
fn bounded(text: &str, max: usize) -> String {
    truncate_utf8(&redact_secrets(text), max).to_owned()
}
fn json_list(text: &str) -> Vec<String> {
    serde_json::from_str(text).unwrap_or_default()
}
fn check_label(text: &str, max: usize) -> Result<()> {
    if text.len() > max || text.chars().any(char::is_control) {
        Err("Invalid or oversized memory label.".into())
    } else {
        Ok(())
    }
}

pub fn repository_identity(root: &Path) -> String {
    let Ok(file) = fs::File::open(root.join(".git/config")) else {
        return String::new();
    };
    let mut text = String::new();
    if file.take(32 * 1024).read_to_string(&mut text).is_err() {
        return String::new();
    }
    let mut origin = false;
    for line in text.lines() {
        let line = line.trim();
        if line.starts_with('[') {
            origin = line == "[remote \"origin\"]";
        }
        if origin {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "url" {
                    return normalize_repository_identity(value.trim());
                }
            }
        }
    }
    String::new()
}
fn normalize_repository_identity(value: &str) -> String {
    let normalized = if let Ok(url) = reqwest::Url::parse(value) {
        if !matches!(url.scheme(), "https" | "http" | "ssh" | "git") {
            return String::new();
        }
        let Some(host) = url.host_str() else {
            return String::new();
        };
        format!(
            "{}/{}",
            host.to_lowercase(),
            url.path().trim_start_matches('/')
        )
    } else if let Some((authority, path)) = value.split_once(':') {
        let host = authority.rsplit('@').next().unwrap_or("");
        if !host.contains('.') || host.contains(['/', '\\', ' ']) {
            return String::new();
        }
        format!("{}/{path}", host.to_lowercase())
    } else {
        return String::new();
    };
    let normalized = normalized.trim_end_matches('/').trim_end_matches(".git");
    if check_label(normalized, 500).is_err()
        || normalized.contains(['?', '#'])
        || normalized.contains("[REDACTED")
    {
        return String::new();
    }
    normalized.to_owned()
}
pub fn stack_for(root: &Path) -> Vec<String> {
    let markers = [
        ("Cargo.toml", "rust"),
        ("package.json", "javascript"),
        ("tsconfig.json", "typescript"),
        ("pyproject.toml", "python"),
        ("requirements.txt", "python"),
        ("go.mod", "go"),
        ("Gemfile", "ruby"),
        ("pom.xml", "java"),
        ("composer.json", "php"),
    ];
    markers
        .into_iter()
        .filter(|(file, _)| root.join(file).is_file())
        .map(|(_, tag)| tag.to_owned())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

impl Engine {
    pub fn capture_forgotten(
        &self,
        project: &str,
        session: &str,
        provider: &str,
        title: &str,
    ) -> Result<bool> {
        self.connection()?.query_row("SELECT EXISTS(SELECT 1 FROM memory_forgotten_captures WHERE project_key=?1 AND fingerprint=?2)",params![project,digest(&format!("{session}\0{provider}\0{title}"))],|r|r.get(0)).map_err(db_error)
    }
    pub fn note_delivered(
        &self,
        project: &str,
        conversation: &str,
        id: &str,
        revision: u64,
    ) -> Result<bool> {
        let found:Option<u64>=self.connection()?.query_row("SELECT revision FROM memory_delivery WHERE project_key=?1 AND conversation=?2 AND memory_id=?3",params![project,conversation,id],|r|row_u64(r,0)).optional().map_err(db_error)?;
        Ok(found.is_some_and(|value| value >= revision))
    }
    /// A path is evidence of a local checkout, never an implicit permission to merge remotes.
    pub fn register_project(&self, path: &str, name: Option<&str>) -> Result<String> {
        let canonical = project_key(Path::new(path))?;
        let root = Path::new(&canonical);
        let label = bounded(
            name.filter(|v| !v.trim().is_empty()).unwrap_or_else(|| {
                root.file_name()
                    .and_then(|v| v.to_str())
                    .unwrap_or("Project")
            }),
            120,
        );
        let stack = stack_for(root);
        let identity = repository_identity(root);
        let mut connection = self.connection()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let known: Option<String> = tx
            .query_row(
                "SELECT project_id FROM memory_project_paths WHERE path=?1",
                [&canonical],
                |row| row.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if let Some(id) = known {
            tx.execute("UPDATE memory_projects SET stack=CASE WHEN ?2<>'[]' THEN ?2 ELSE stack END,repository_identity=CASE WHEN ?3<>'' THEN ?3 ELSE repository_identity END WHERE id=?1",params![id,serde_json::to_string(&stack).unwrap(),identity]).map_err(db_error)?;
            tx.commit().map_err(db_error)?;
            return Ok(id);
        }
        let id = format!("agentdeck:project:{}", uuid::Uuid::new_v4());
        tx.execute("INSERT INTO memory_projects(id,name,stack,repository_identity,updated_at) VALUES(?1,?2,?3,?4,?5)",params![id,label,serde_json::to_string(&stack).unwrap(),identity,now_ms()]).map_err(db_error)?;
        tx.execute(
            "INSERT INTO memory_project_paths(path,project_id) VALUES(?1,?2)",
            params![canonical, id],
        )
        .map_err(db_error)?;
        for table in [
            "memory_records",
            "memory_config",
            "memory_delivery",
            "context_delivery",
            "memory_events",
            "memory_profile_evidence",
            "memory_export_targets",
            "memory_forgotten_captures",
            "memory_curation",
        ] {
            tx.execute(
                &format!("UPDATE {table} SET project_key=?2 WHERE project_key=?1"),
                params![canonical, id],
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(id)
    }

    pub fn catalog(&self, query: &str) -> Result<Vec<CatalogProject>> {
        let connection = self.connection()?;
        let mut stmt=connection.prepare("SELECT id,name,description,stack,repository_identity,updated_at,contribute,consume,discovery,visible FROM memory_projects ORDER BY name,id LIMIT 1000").map_err(db_error)?;
        let rows = stmt
            .query_map([], |r| {
                Ok(CatalogProject {
                    id: r.get(0)?,
                    name: r.get(1)?,
                    description: r.get(2)?,
                    stack: json_list(&r.get::<_, String>(3)?),
                    repository_identity: r.get(4)?,
                    updated_at: row_u64(r, 5)?,
                    settings: IntelligenceSettings {
                        contribute: r.get(6)?,
                        consume: r.get(7)?,
                        discovery: r.get(8)?,
                        visible: r.get(9)?,
                    },
                    paths: Vec::new(),
                    record_count: 0,
                })
            })
            .map_err(db_error)?;
        let terms = fts_expression(query)
            .replace('"', "")
            .replace(" OR ", " ")
            .split_whitespace()
            .map(str::to_owned)
            .collect::<Vec<_>>();
        let mut result = Vec::new();
        for row in rows {
            let mut project = row.map_err(db_error)?;
            let haystack = format!(
                "{} {} {}",
                project.name,
                project.description,
                project.stack.join(" ")
            )
            .to_lowercase();
            if !terms.is_empty() && !terms.iter().any(|term| haystack.contains(term)) {
                continue;
            }
            project.paths = connection
                .prepare("SELECT path FROM memory_project_paths WHERE project_id=?1 ORDER BY path")
                .map_err(db_error)?
                .query_map([&project.id], |row| row.get(0))
                .map_err(db_error)?
                .collect::<std::result::Result<_, _>>()
                .map_err(db_error)?;
            project.record_count=connection.query_row("SELECT count(*) FROM memory_records WHERE project_key=?1 AND id NOT IN (SELECT memory_id FROM memory_metadata WHERE state<>'active')",[&project.id],|row|row.get::<_,i64>(0)).map_err(db_error)? as usize;
            result.push(project);
        }
        Ok(result)
    }

    pub fn settings(&self, project: &str) -> Result<IntelligenceSettings> {
        self.connection()?
            .query_row(
                "SELECT contribute,consume,discovery,visible FROM memory_projects WHERE id=?1",
                [project],
                |r| {
                    Ok(IntelligenceSettings {
                        contribute: r.get(0)?,
                        consume: r.get(1)?,
                        discovery: r.get(2)?,
                        visible: r.get(3)?,
                    })
                },
            )
            .optional()
            .map(|v| v.unwrap_or_default())
            .map_err(db_error)
    }
    pub fn update_project(
        &self,
        id: &str,
        name: &str,
        description: &str,
        settings: &IntelligenceSettings,
    ) -> Result<()> {
        check_label(name, 120)?;
        if name.trim().is_empty() || description.len() > 2000 {
            return Err("Provide a name and a description of at most 2000 bytes.".into());
        }
        let count=self.connection()?.execute("UPDATE memory_projects SET name=?2,description=?3,contribute=?4,consume=?5,discovery=?6,visible=?7,updated_at=?8 WHERE id=?1",params![id,bounded(name,120),bounded(description,2000),settings.contribute,settings.consume,settings.discovery,settings.visible,now_ms()]).map_err(db_error)?;
        if count == 0 {
            return Err("Project not found.".into());
        }
        Ok(())
    }
    /// Explicit UI association only. Refuses populated destinations rather than silently merging histories.
    pub fn attach_project_path(&self, target: &str, path: &str) -> Result<()> {
        let canonical = project_key(Path::new(path))?;
        let mut connection = self.connection()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        if !tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_projects WHERE id=?1)",
                [target],
                |r| r.get::<_, bool>(0),
            )
            .map_err(db_error)?
        {
            return Err("Project not found.".into());
        }
        let old: Option<String> = tx
            .query_row(
                "SELECT project_id FROM memory_project_paths WHERE path=?1",
                [&canonical],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?;
        if old.as_deref() == Some(target) {
            return Ok(());
        }
        for owner in old.iter().chain(std::iter::once(&canonical)) {
            let notes:i64=tx.query_row("SELECT (SELECT count(*) FROM memory_records WHERE project_key=?1)+(SELECT count(*) FROM memory_events WHERE project_key=?1)",[owner],|r|r.get(0)).map_err(db_error)?;
            if notes > 0 {
                return Err("This checkout already has memory. Export or archive it before associating it with another project.".into());
            }
        }
        tx.execute("INSERT INTO memory_project_paths(path,project_id) VALUES(?1,?2) ON CONFLICT(path) DO UPDATE SET project_id=excluded.project_id",params![canonical,target]).map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok(())
    }
    pub fn can_discover(&self, from: &str, target: &str) -> Result<bool> {
        Ok(from == target
            || (self.config(from)?.enabled
                && self.config(target)?.enabled
                && self.settings(from)?.discovery
                && self.settings(target)?.visible
                && self.catalog("")?.iter().any(|p| p.id == target)))
    }
    pub fn refresh_catalog_summary(&self, project: &str) -> Result<()> {
        let connection = self.connection()?;
        let titles=connection.prepare("SELECT title FROM memory_records WHERE project_key=?1 AND kind='decision' AND id NOT IN (SELECT memory_id FROM memory_metadata WHERE state<>'active') ORDER BY updated_at DESC,id LIMIT 3").map_err(db_error)?.query_map([project],|r|r.get::<_,String>(0)).map_err(db_error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(db_error)?;
        // A user-written description is never replaced by extraction.
        connection.execute("UPDATE memory_projects SET description=?2,updated_at=?3 WHERE id=?1 AND (description='' OR description LIKE 'Decisions: %')",params![project,if titles.is_empty(){String::new()}else{format!("Decisions: {}",titles.join("; "))},now_ms()]).map_err(db_error)?;
        Ok(())
    }

    pub fn metadata(&self, project: &str, id: &str) -> Result<MemoryMetadata> {
        if self.get(project, id)?.is_none() {
            return Err("Memory not found in this scope.".into());
        }
        self.connection()?.query_row("SELECT category,applies_to,state,superseded_by,relations,access_count,last_accessed_at,feedback FROM memory_metadata WHERE memory_id=?1",[id],|r|Ok(MemoryMetadata{category:r.get(0)?,applies_to:json_list(&r.get::<_,String>(1)?),state:r.get(2)?,superseded_by:r.get(3)?,relations:serde_json::from_str(&r.get::<_,String>(4)?).unwrap_or_default(),access_count:row_u64(r,5)?,last_accessed_at:row_u64(r,6)?,feedback:r.get(7)?})).optional().map(|v|v.unwrap_or_default()).map_err(db_error)
    }
    pub fn set_metadata(&self, project: &str, id: &str, metadata: &MemoryMetadata) -> Result<()> {
        if !matches!(
            metadata.category.as_str(),
            "" | "preference" | "procedure" | "gotcha" | "lesson"
        ) || !matches!(
            metadata.state.as_str(),
            "active" | "archived" | "stale" | "superseded"
        ) || !matches!(
            metadata.feedback.as_str(),
            "" | "helpful" | "not-helpful" | "wrong"
        ) {
            return Err("Invalid memory metadata.".into());
        }
        if metadata.applies_to.len() > 16
            || metadata
                .applies_to
                .iter()
                .any(|tag| check_label(tag, 40).is_err())
        {
            return Err("Too many or invalid applicability tags.".into());
        }
        if metadata.relations.len() > 3
            || metadata.relations.iter().any(|(kind, ids)| {
                !matches!(kind.as_str(), "fixes" | "causes" | "contradicts") || ids.len() > 16
            })
        {
            return Err("Invalid memory relationships.".into());
        }
        let mut connection = self.connection()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let exists = |id: &str| {
            tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM memory_records WHERE project_key=?1 AND id=?2)",
                params![project, id],
                |r| r.get::<_, bool>(0),
            )
            .map_err(db_error)
        };
        if !exists(id)? {
            return Err("Memory not found in this scope.".into());
        }
        if metadata.state=="active" && tx.query_row("SELECT EXISTS(SELECT 1 FROM memory_metadata WHERE memory_id=?1 AND state<>'active')",[id],|r|r.get::<_,bool>(0)).map_err(db_error)? {
            let count:i64=tx.query_row("SELECT count(*) FROM memory_records WHERE project_key=?1 AND id NOT IN(SELECT memory_id FROM memory_metadata WHERE state<>'active')",[project],|r|r.get(0)).map_err(db_error)?;
            if count>=MAX_RECORDS as i64{return Err("Archive another active note before restoring this one; memory capacity has been reached.".into());}
        }
        for other in metadata
            .relations
            .values()
            .flatten()
            .chain(metadata.superseded_by.iter())
        {
            if other == id || !exists(other)? {
                return Err(
                    "A related note must exist in the same scope and differ from this note.".into(),
                );
            }
        }
        if metadata.state == "superseded" && metadata.superseded_by.is_none() {
            return Err("Select the note that replaces this one.".into());
        }
        tx.execute("INSERT INTO memory_metadata(memory_id,category,applies_to,state,superseded_by,relations,feedback,archived_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8) ON CONFLICT(memory_id) DO UPDATE SET category=excluded.category,applies_to=excluded.applies_to,state=excluded.state,superseded_by=excluded.superseded_by,relations=excluded.relations,feedback=excluded.feedback,archived_at=excluded.archived_at",params![id,metadata.category,serde_json::to_string(&metadata.applies_to).unwrap(),metadata.state,metadata.superseded_by,serde_json::to_string(&metadata.relations).unwrap(),metadata.feedback,if metadata.state=="archived"{Some(now_ms())}else{None}]).map_err(db_error)?;
        tx.execute(
            "UPDATE memory_records SET revision=revision+1,updated_at=?2 WHERE id=?1",
            params![id, now_ms()],
        )
        .map_err(db_error)?;
        tx.execute("DELETE FROM memory_delivery WHERE memory_id=?1", [id])
            .map_err(db_error)?;
        tx.commit().map_err(db_error)
    }
    pub fn versions(&self, project: &str, id: &str) -> Result<Vec<MemoryVersion>> {
        if self.get(project, id)?.is_none() {
            return Err("Memory not found in this scope.".into());
        }
        let connection = self.connection()?;
        let values=connection.prepare("SELECT snapshot,recorded_at FROM memory_versions WHERE memory_id=?1 ORDER BY revision DESC LIMIT 100").map_err(db_error)?.query_map([id],|r|Ok((r.get::<_,String>(0)?,row_u64(r,1)?))).map_err(db_error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(db_error)?;
        values
            .into_iter()
            .map(|(snapshot, recorded_at)| {
                Ok(MemoryVersion {
                    record: serde_json::from_str(&snapshot).map_err(|e| e.to_string())?,
                    recorded_at,
                })
            })
            .collect()
    }
    pub fn restore_version(&self, project: &str, id: &str, revision: u64) -> Result<MemoryRecord> {
        let version = self
            .versions(project, id)?
            .into_iter()
            .find(|v| v.record.revision == revision)
            .ok_or("Version not found in this scope.")?;
        self.save(
            project,
            &MemoryDraft {
                id: Some(id.into()),
                title: version.record.title,
                content: version.record.content,
                kind: version.record.kind,
                pinned: version.record.pinned,
            },
            None,
            None,
        )
    }
    pub fn inactive_notes(&self, project: &str) -> Result<Vec<MemoryRecord>> {
        let connection = self.connection()?;
        let result=connection.prepare(&format!("SELECT {COLUMNS} FROM memory_records m JOIN memory_metadata x ON x.memory_id=m.id WHERE m.project_key=?1 AND x.state<>'active' ORDER BY m.updated_at DESC LIMIT 1000")).map_err(db_error)?.query_map([project],record_from_row).map_err(db_error)?.collect::<std::result::Result<_,_>>().map_err(db_error);
        result
    }
    pub fn touch(&self, project: &str, id: &str) -> Result<()> {
        let connection = self.connection()?;
        connection.execute("INSERT INTO memory_metadata(memory_id,access_count,last_accessed_at) SELECT id,1,?3 FROM memory_records WHERE project_key=?1 AND id=?2 ON CONFLICT(memory_id) DO UPDATE SET access_count=access_count+1,last_accessed_at=excluded.last_accessed_at WHERE last_accessed_at<?3-60000",params![project,id,now_ms()]).map_err(db_error)?;
        Ok(())
    }
    pub fn maintain(&self, project: &str, apply: bool) -> Result<Vec<MemoryRecord>> {
        let connection = self.connection()?;
        let before = now_ms() - 90 * 24 * 60 * 60 * 1000_i64;
        let notes=connection.prepare(&format!("SELECT {COLUMNS} FROM memory_records m LEFT JOIN memory_metadata x ON x.memory_id=m.id WHERE m.project_key=?1 AND m.source='capture' AND m.kind='handoff' AND m.pinned=0 AND m.updated_at<?2 AND coalesce(x.state,'active')='active' AND coalesce(x.last_accessed_at,0)<?2 ORDER BY coalesce(x.access_count,0),m.updated_at LIMIT 100")).map_err(db_error)?.query_map(params![project,before],record_from_row).map_err(db_error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(db_error)?;
        drop(connection);
        if apply {
            for record in &notes {
                let mut metadata = self.metadata(project, &record.id)?;
                metadata.state = "archived".into();
                self.set_metadata(project, &record.id, &metadata)?;
            }
        }
        Ok(notes)
    }

    pub fn record_event(
        &self,
        project: &str,
        session: &str,
        provider: &str,
        event: &MemoryEvent,
    ) -> Result<bool> {
        validate_conversation(session)?;
        check_label(provider, 100)?;
        check_label(&event.id, 256)?;
        if event.id.is_empty()
            || !matches!(
                event.kind.as_str(),
                "prompt"
                    | "addition"
                    | "file"
                    | "tool"
                    | "verification"
                    | "failure"
                    | "answer"
                    | "turn-end"
                    | "session-end"
            )
        {
            return Err("Invalid structured memory event.".into());
        }
        let config = self.config(project)?;
        if project == GLOBAL_MEMORY_KEY || !config.enabled || !config.capture_enabled {
            return Ok(false);
        }
        let title = bounded(&event.title, 240);
        let summary = bounded(&event.summary, 1600);
        let files = event
            .files
            .iter()
            .take(16)
            .map(|file| bounded(file, 300))
            .collect::<Vec<_>>();
        let event_key = digest(&format!("{project}\0{provider}\0{session}\0{}", event.id));
        let inserted=self.connection()?.execute("INSERT OR IGNORE INTO memory_events(id,project_key,session_id,provider,kind,title,summary,files,branch,observed_at) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![event_key,project,session,provider,event.kind,title,summary,serde_json::to_string(&files).unwrap(),bounded(&event.branch,120),now_ms()]).map_err(db_error)?;
        if inserted == 0 {
            return Ok(false);
        }
        if matches!(event.kind.as_str(), "prompt" | "addition")
            && self.settings(project)?.contribute
        {
            self.harvest_preferences(project, &event_key, &summary)?;
            if self.curation_enabled(project)? {
                self.curate_profiles()?;
            }
        }
        // Preserve bounded raw evidence; pruning never destroys the only durable handoff.
        if matches!(event.kind.as_str(), "turn-end" | "session-end") {
            self.structured_handoff(project, session, provider)?;
        }
        Ok(true)
    }
    pub fn events(&self, project: &str, session: &str, provider: &str) -> Result<Vec<MemoryEvent>> {
        let connection = self.connection()?;
        let result:Result<Vec<MemoryEvent>>=connection.prepare("SELECT id,kind,title,summary,files,branch FROM (SELECT rowid AS event_order,* FROM memory_events WHERE project_key=?1 AND session_id=?2 AND provider=?3 ORDER BY observed_at DESC,rowid DESC LIMIT 40) ORDER BY observed_at,event_order").map_err(db_error)?.query_map(params![project,session,provider],|r|Ok(MemoryEvent{id:r.get(0)?,kind:r.get(1)?,title:r.get(2)?,summary:r.get(3)?,files:json_list(&r.get::<_,String>(4)?),branch:r.get(5)?})).map_err(db_error)?.collect::<std::result::Result<_,_>>().map_err(db_error);
        let mut events = result?;
        if !events.iter().any(|e| e.kind == "prompt") {
            let prompt=connection.query_row("SELECT id,kind,title,summary,files,branch FROM memory_events WHERE project_key=?1 AND session_id=?2 AND provider=?3 AND kind='prompt' ORDER BY observed_at DESC,rowid DESC LIMIT 1",params![project,session,provider],|r|Ok(MemoryEvent{id:r.get(0)?,kind:r.get(1)?,title:r.get(2)?,summary:r.get(3)?,files:json_list(&r.get::<_,String>(4)?),branch:r.get(5)?})).optional().map_err(db_error)?;
            if let Some(prompt) = prompt {
                events.insert(0, prompt);
            }
        }
        Ok(events)
    }
    fn structured_handoff(&self, project: &str, session: &str, provider: &str) -> Result<()> {
        let events = self.events(project, session, provider)?;
        let Some(prompt) = events.iter().rev().find(|event| event.kind == "prompt") else {
            return Ok(());
        };
        let after = events.iter().rposition(|e| e.kind == "prompt").unwrap_or(0);
        if prompt.summary.trim_start().starts_with('/') {
            return Ok(());
        }
        let automatic = self.curation_enabled(project)?;
        let previous = if automatic {
            self.curated_checkpoint(project, session, provider)?
        } else {
            None
        };
        let useful = events[after..].iter().any(|e| {
            !e.files.is_empty()
                || matches!(e.kind.as_str(), "verification" | "failure")
                || (e.kind == "answer" && e.summary.trim().len() >= 160)
        });
        if automatic && !useful {
            return Ok(());
        }
        let objective = previous
            .as_ref()
            .and_then(|note| {
                note.content
                    .lines()
                    .find_map(|line| line.strip_prefix("Objective: "))
            })
            .unwrap_or(&prompt.summary);
        let mut content = format!("Objective: {}\n", bounded(objective, 600));
        if automatic && objective != prompt.summary {
            content.push_str(&format!(
                "Latest request: {}\n",
                bounded(&prompt.summary, 300)
            ));
        }
        let files = events[after..]
            .iter()
            .flat_map(|e| e.files.iter().cloned())
            .collect::<BTreeSet<_>>();
        if !files.is_empty() {
            content.push_str(&format!(
                "Files: {}\n",
                bounded(&files.into_iter().collect::<Vec<_>>().join(", "), 600)
            ));
        } else if let Some(previous) = &previous {
            if let Some(line) = previous
                .content
                .lines()
                .find(|line| line.starts_with("Files: "))
            {
                content.push_str(&format!("{}\n", bounded(line, 610)));
            }
        }
        for kind in ["failure", "verification", "answer"] {
            let maximum = if kind == "answer" { 1 } else { 2 };
            let allowance = if kind == "answer" { 600 } else { 240 };
            for event in events[after..]
                .iter()
                .rev()
                .filter(|e| e.kind == kind)
                .take(maximum)
            {
                content.push_str(&format!(
                    "{}: {}\n",
                    kind,
                    bounded(&event.summary, allowance)
                ));
            }
        }
        if let Some(end) = events
            .iter()
            .rev()
            .find(|e| matches!(e.kind.as_str(), "turn-end" | "session-end"))
        {
            content.push_str(&format!("Pending: {}\n", bounded(&end.summary, 240)));
        }
        content.push_str("Historical event evidence; verify current files and tests. A turn boundary does not mean the task is complete.");
        let subject = prompt
            .summary
            .lines()
            .find(|line| !line.trim().is_empty())
            .unwrap_or("Latest completed work");
        let title = if automatic {
            "Conversation context".to_owned()
        } else {
            format!("Handoff · {}", bounded(subject, 160))
        };
        if self.capture_forgotten(project, session, provider, &title)?
            || self.capture_forgotten(
                project,
                session,
                provider,
                &format!("Handoff · {}", bounded(subject, 160)),
            )?
        {
            return Ok(());
        }
        self.write_record(
            project,
            &MemoryDraft {
                id: previous.as_ref().map(|note| note.id.clone()),
                title,
                content: bounded(&content, MAX_CAPTURE_BYTES),
                kind: "handoff".into(),
                pinned: false,
            },
            Some(session),
            Some(provider),
            "capture",
        )?;
        self.refresh_catalog_summary(project)
    }

    fn harvest_preferences(&self, project: &str, event_id: &str, prompt: &str) -> Result<()> {
        for found in detect_preferences(prompt) {
            let mut connection = self.connection()?;
            let tx = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(db_error)?;
            let id = digest(&format!("{}\0{}", found.topic, found.statement));
            tx.execute("INSERT OR IGNORE INTO memory_profile_candidates(id,topic,statement,category,applies_to,general,updated_at) VALUES(?1,?2,?3,?4,?5,?6,?7)",params![id,found.topic,found.statement,found.category,serde_json::to_string(&found.applies_to).unwrap(),found.general,now_ms()]).map_err(db_error)?;
            tx.execute("INSERT OR IGNORE INTO memory_profile_evidence(candidate_id,project_key,event_id,quote,observed_at) VALUES(?1,?2,?3,?4,?5)",params![id,project,event_id,found.statement,now_ms()]).map_err(db_error)?;
            tx.commit().map_err(db_error)?;
        }
        Ok(())
    }
    pub fn profile_candidates(&self) -> Result<Vec<ProfileCandidate>> {
        let connection = self.connection()?;
        let mut candidates=connection.prepare("SELECT id,topic,statement,category,applies_to,general,status,record_id,updated_at FROM memory_profile_candidates ORDER BY updated_at DESC,id LIMIT 300").map_err(db_error)?.query_map([],|r|Ok(ProfileCandidate{id:r.get(0)?,topic:r.get(1)?,statement:r.get(2)?,category:r.get(3)?,applies_to:json_list(&r.get::<_,String>(4)?),general:r.get(5)?,status:r.get(6)?,record_id:r.get(7)?,updated_at:row_u64(r,8)?,evidence:Vec::new(),project_count:0,eligible:false})).map_err(db_error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(db_error)?;
        for candidate in &mut candidates {
            candidate.evidence=connection.prepare("SELECT e.project_key,e.event_id,e.quote,e.observed_at FROM memory_profile_evidence e LEFT JOIN memory_projects p ON p.id=e.project_key WHERE e.candidate_id=?1 AND coalesce(p.contribute,1)=1 ORDER BY e.observed_at DESC,e.event_id LIMIT 50").map_err(db_error)?.query_map([&candidate.id],|r|Ok(ProfileEvidence{project_key:r.get(0)?,event_id:r.get(1)?,quote:r.get(2)?,observed_at:row_u64(r,3)?})).map_err(db_error)?.collect::<std::result::Result<_,_>>().map_err(db_error)?;
            candidate.project_count = candidate
                .evidence
                .iter()
                .map(|e| &e.project_key)
                .collect::<HashSet<_>>()
                .len();
            candidate.eligible = !candidate.evidence.is_empty()
                && (candidate.general || candidate.project_count >= 2);
        }
        Ok(candidates)
    }
    pub fn review_profile(&self, id: &str, accept: bool) -> Result<Option<MemoryRecord>> {
        self.review_profile_impl(id, accept, false)
    }
    pub(super) fn review_profile_impl(
        &self,
        id: &str,
        accept: bool,
        automatic: bool,
    ) -> Result<Option<MemoryRecord>> {
        let candidate = self
            .profile_candidates()?
            .into_iter()
            .find(|c| c.id == id)
            .ok_or("Preference candidate not found.")?;
        if candidate.status != "candidate" {
            return Err("This preference has already been reviewed.".into());
        }
        if !accept {
            let changed=self.connection()?.execute("UPDATE memory_profile_candidates SET status='rejected',updated_at=?2 WHERE id=?1 AND status='candidate'",params![id,now_ms()]).map_err(db_error)?;
            if changed == 0 {
                return Err("This preference has already been reviewed.".into());
            }
            return Ok(None);
        }
        if candidate.evidence.is_empty() {
            return Err("This preference no longer has contributing evidence.".into());
        }
        let mut connection = self.connection()?;
        let tx = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(db_error)?;
        let state: String = tx
            .query_row(
                "SELECT status FROM memory_profile_candidates WHERE id=?1",
                [id],
                |r| r.get(0),
            )
            .map_err(db_error)?;
        if state != "candidate" {
            if automatic {
                return Ok(None);
            }
            return Err("This preference has already been reviewed.".into());
        }
        if automatic
            && curation::automatic_profile_conflict(&tx, &candidate.topic, &candidate.statement)?
        {
            return Ok(None);
        }
        let count:i64=tx.query_row("SELECT count(*) FROM memory_records WHERE project_key=?1 AND id NOT IN(SELECT memory_id FROM memory_metadata WHERE state<>'active')",[GLOBAL_MEMORY_KEY],|r|r.get(0)).map_err(db_error)?;
        if count >= MAX_RECORDS as i64 {
            if automatic {
                return Ok(None);
            }
            return Err("Global memory capacity reached; archive an older note first.".into());
        }
        let record_id = uuid::Uuid::new_v4().to_string();
        let at = now_ms();
        let content = format!(
            "{}\n\n{} from {} contributing project(s). Evidence:\n{}",
            candidate.statement,
            if automatic {
                "Selected automatically by local rules"
            } else {
                "Approved by the user"
            },
            candidate.project_count,
            candidate
                .evidence
                .iter()
                .take(5)
                .map(|e| format!("- {}: {}", e.project_key, e.quote))
                .collect::<Vec<_>>()
                .join("\n")
        );
        tx.execute("INSERT INTO memory_records(id,project_key,title,content,kind,updated_at,revision,pinned,source,verification) VALUES(?1,?2,?3,?4,'fact',?5,1,1,?6,?7)",params![record_id,GLOBAL_MEMORY_KEY,bounded(&candidate.statement,160),bounded(&content,MAX_CONTENT_BYTES),at,if automatic { "curation" } else { "manual" },if automatic { "auto-selected" } else { "user-confirmed" }]).map_err(db_error)?;
        tx.execute(
            "INSERT INTO memory_metadata(memory_id,category,applies_to) VALUES(?1,'preference',?2)",
            params![
                record_id,
                serde_json::to_string(&candidate.applies_to).unwrap()
            ],
        )
        .map_err(db_error)?;
        tx.execute("UPDATE memory_metadata SET state='superseded',superseded_by=?2 WHERE state='active' AND memory_id IN(SELECT c.record_id FROM memory_profile_candidates c JOIN memory_records m ON m.id=c.record_id WHERE c.topic=?1 AND c.status='accepted' AND m.project_key=?3 AND substr(m.content,1,length(c.statement))=c.statement)",params![candidate.topic,record_id,GLOBAL_MEMORY_KEY]).map_err(db_error)?;
        tx.execute("UPDATE memory_profile_candidates SET status='accepted',record_id=?2,updated_at=?3 WHERE id=?1",params![id,record_id,at]).map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        drop(connection);
        self.get(GLOBAL_MEMORY_KEY, &record_id)
    }
    pub fn applies(&self, project: &str, record: &MemoryRecord) -> Result<bool> {
        let metadata = self.metadata(
            if record.scope == "global" {
                GLOBAL_MEMORY_KEY
            } else {
                project
            },
            &record.id,
        )?;
        if metadata.state != "active" || metadata.feedback == "wrong" {
            return Ok(false);
        }
        if record.scope == "global"
            && metadata.category == "preference"
            && !self.settings(project)?.consume
        {
            return Ok(false);
        }
        if metadata.applies_to.is_empty() {
            return Ok(true);
        }
        let tags = self
            .catalog("")?
            .into_iter()
            .find(|p| p.id == project)
            .map(|p| p.stack)
            .unwrap_or_default();
        Ok(metadata.applies_to.iter().any(|tag| tags.contains(tag)))
    }
}

struct DetectedPreference {
    topic: String,
    statement: String,
    category: String,
    applies_to: Vec<String>,
    general: bool,
}
fn detect_preferences(prompt: &str) -> Vec<DetectedPreference> {
    let mut fenced = false;
    let mut found = Vec::new();
    for line in prompt.lines().take(60) {
        if line.trim_start().starts_with("```") || line.trim_start().starts_with("~~~") {
            fenced = !fenced;
            continue;
        }
        if fenced || line.contains('?') || line.contains("<agentdeck_") {
            continue;
        }
        for sentence in line.split(['.', '!', ';']) {
            let sentence = sentence.trim();
            if sentence.len() < 12 || sentence.len() > 600 {
                continue;
            }
            let lower = sentence.to_lowercase();
            let marker = [
                "prefiro ",
                "prefira ",
                "sempre use ",
                "sempre usar ",
                "sempre rode ",
                "nunca use ",
                "não use ",
                "por padrão ",
                "em todos os meus projetos",
                "i prefer ",
                "always use ",
                "never use ",
                "by default ",
                "in all my projects",
            ]
            .iter()
            .any(|m| lower.contains(m));
            if !marker {
                continue;
            }
            let general = [
                "em todos os meus projetos",
                "em todo projeto",
                "in all my projects",
                "across all projects",
                "por padrão",
                "by default",
            ]
            .iter()
            .any(|m| lower.contains(m));
            let (topic, category, tags) = if ["pnpm", "npm", "bun", "yarn"]
                .iter()
                .any(|v| lower.split_whitespace().any(|w| w == *v))
            {
                (
                    "package-manager".into(),
                    "tools",
                    vec!["javascript".into(), "typescript".into()],
                )
            } else if lower.contains("teste") || lower.contains("test") {
                ("testing".into(), "testing", Vec::new())
            } else if lower.contains("portugu")
                || lower.contains("english")
                || lower.contains("idioma")
            {
                ("language".into(), "style", Vec::new())
            } else {
                (
                    fts_expression(sentence)
                        .replace('"', "")
                        .replace(" OR ", " "),
                    "workflow",
                    Vec::new(),
                )
            };
            found.push(DetectedPreference {
                topic,
                statement: bounded(sentence, 400),
                category: category.into(),
                applies_to: tags,
                general,
            });
            if found.len() == 8 {
                return found;
            }
        }
    }
    found
}

pub(super) fn archive_capacity(tx: &rusqlite::Transaction<'_>, project: &str) -> Result<usize> {
    tx.execute("INSERT INTO memory_metadata(memory_id,state,archived_at) SELECT id,'archived',?2 FROM memory_records WHERE id=(SELECT m.id FROM memory_records m LEFT JOIN memory_metadata x ON x.memory_id=m.id WHERE m.project_key=?1 AND m.source='capture' AND m.pinned=0 AND coalesce(x.state,'active')='active' ORDER BY coalesce(x.access_count,0),m.updated_at,m.id LIMIT 1) ON CONFLICT(memory_id) DO UPDATE SET state='archived',archived_at=excluded.archived_at",params![project,now_ms()]).map_err(db_error)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportChange {
    pub path: String,
    pub action: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPlan {
    pub directory: String,
    pub changes: Vec<ExportChange>,
    pub conflicts: Vec<String>,
    pub record_count: usize,
    pub applied: bool,
}

#[derive(Default, Serialize, Deserialize)]
struct ExportManifest {
    project: String,
    files: HashMap<String, String>,
}

impl Engine {
    pub fn incremental_export(
        &self,
        project: &str,
        destination: &Path,
        apply: bool,
    ) -> Result<ExportPlan> {
        let destination =
            fs::canonicalize(destination).map_err(|e| format!("Export folder: {e}"))?;
        if !destination.is_dir() {
            return Err("Choose an existing export folder.".into());
        }
        let directory = destination.join(format!(
            "Agentdeck-{}-{}",
            scope_name(project),
            &digest(project)[..12]
        ));
        if directory.exists()
            && (fs::symlink_metadata(&directory)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
                || fs::canonicalize(&directory)
                    .map_err(|e| e.to_string())?
                    .parent()
                    != Some(destination.as_path()))
        {
            return Err(
                "Export directory must be a regular folder inside the chosen destination.".into(),
            );
        }
        let manifest_path = directory.join(".agentdeck-export.json");
        let old: ExportManifest = if manifest_path.exists() {
            if fs::symlink_metadata(&manifest_path)
                .map_err(|e| e.to_string())?
                .file_type()
                .is_symlink()
            {
                return Err("Export manifest cannot be a link.".into());
            }
            let bytes = fs::read(&manifest_path).map_err(|e| e.to_string())?;
            if bytes.len() > 1024 * 1024 {
                return Err("Export manifest exceeds limit.".into());
            }
            serde_json::from_slice(&bytes).map_err(|e| format!("Invalid export manifest: {e}"))?
        } else {
            ExportManifest::default()
        };
        if !old.project.is_empty() && old.project != project {
            return Err("This export belongs to another scope.".into());
        }
        let records = self.list(project, "")?;
        let mut files = Vec::new();
        let mut index=String::from("# Agentdeck memory\n\nDatabase projection. Local changes are preserved and reported as conflicts; they are not imported.\n\n");
        for record in &records {
            let name = format!("memory-{}.md", record.id);
            if !record
                .id
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-')
            {
                return Err("Invalid export record identifier.".into());
            }
            index.push_str(&format!(
                "- [[memory-{}|{}]]\n",
                record.id,
                record.title.replace(['[', ']', '|'], " ")
            ));
            let metadata = self.metadata(project, &record.id)?;
            let related = metadata
                .relations
                .values()
                .flatten()
                .map(|id| format!("[[memory-{id}]]"))
                .collect::<Vec<_>>()
                .join(" ");
            files.push((name,format!("---\napp: Agentdeck\nid: {}\nproject: {}\nrevision: {}\nkind: {}\nscope: {}\nsource: {}\nverification: {}\ncategory: {}\napplies_to: {}\nstate: {}\nrelations: {}\n---\n\n# {}\n\n{}\n\n{}\n\n[[Agentdeck index]]\n",serde_json::to_string(&record.id).unwrap(),serde_json::to_string(project).unwrap(),record.revision,record.kind,record.scope,record.source,record.verification,serde_json::to_string(&metadata.category).unwrap(),serde_json::to_string(&metadata.applies_to).unwrap(),metadata.state,serde_json::to_string(&metadata.relations).unwrap(),record.title,record.content,related)));
        }
        files.push(("Agentdeck index.md".into(), index));
        let mut plan = ExportPlan {
            directory: directory
                .to_string_lossy()
                .trim_start_matches("\\\\?\\")
                .into(),
            changes: Vec::new(),
            conflicts: Vec::new(),
            record_count: records.len(),
            applied: false,
        };
        let mut manifest = ExportManifest {
            project: project.into(),
            files: old.files.clone(),
        };
        let mut writes = Vec::new();
        let mut observed = Vec::new();
        for (name, content) in files {
            let target = directory.join(&name);
            let wanted = digest(&content);
            let current = if target.exists() {
                let metadata = fs::symlink_metadata(&target).map_err(|e| e.to_string())?;
                if !metadata.is_file()
                    || metadata.file_type().is_symlink()
                    || metadata.len() > 256 * 1024
                {
                    return Err("Export target must be a bounded regular file.".into());
                }
                Some(format!(
                    "{:x}",
                    Sha256::digest(fs::read(&target).map_err(|e| e.to_string())?)
                ))
            } else {
                None
            };
            let action = if current.as_deref() == Some(&wanted) {
                "unchanged"
            } else if current.is_none() {
                "create"
            } else if old.files.get(&name) == current.as_ref() {
                "update"
            } else {
                plan.conflicts.push(name.clone());
                "conflict"
            };
            observed.push((name.clone(), current.clone()));
            plan.changes.push(ExportChange {
                path: name.clone(),
                action: action.into(),
            });
            if action != "conflict" {
                manifest.files.insert(name.clone(), wanted);
            }
            if matches!(action, "create" | "update") {
                writes.push((name, content));
            }
        }
        // Missing database notes are retained in the projection, never silently deleted.
        for old_name in old.files.keys() {
            if !plan.changes.iter().any(|c| &c.path == old_name) {
                plan.changes.push(ExportChange {
                    path: old_name.clone(),
                    action: "retained".into(),
                });
            }
        }
        if apply {
            if !plan.conflicts.is_empty() {
                return Ok(plan);
            }
            fs::create_dir_all(&directory).map_err(|e| e.to_string())?;
            // Recheck all hashes immediately before writes; a newer local edit cancels the batch.
            for (name, expected) in observed {
                let target = directory.join(&name);
                let current = if target.exists() {
                    Some(export_file_hash(&target)?)
                } else {
                    None
                };
                if current != expected {
                    plan.conflicts.push(name);
                }
            }
            if !plan.conflicts.is_empty() {
                return Ok(plan);
            }
            for (name, content) in writes {
                atomic_export_write(&directory.join(name), content.as_bytes())?;
            }
            atomic_export_write(
                &manifest_path,
                &serde_json::to_vec_pretty(&manifest).map_err(|e| e.to_string())?,
            )?;
            self.connection()?.execute("INSERT INTO memory_export_targets(project_key,directory) VALUES(?1,?2) ON CONFLICT(project_key) DO UPDATE SET directory=excluded.directory",params![project,destination.to_string_lossy()]).map_err(db_error)?;
            plan.applied = true;
        }
        Ok(plan)
    }
}
fn export_file_hash(path: &Path) -> Result<String> {
    let metadata = fs::symlink_metadata(path).map_err(|e| e.to_string())?;
    if !metadata.is_file() || metadata.file_type().is_symlink() || metadata.len() > 256 * 1024 {
        return Err("Export target must be a bounded regular file".into());
    }
    Ok(format!(
        "{:x}",
        Sha256::digest(fs::read(path).map_err(|e| e.to_string())?)
    ))
}
fn atomic_export_write(path: &Path, bytes: &[u8]) -> Result<()> {
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|e| e.to_string())?;
    file.write_all(bytes)
        .and_then(|_| file.sync_all())
        .map_err(|e| e.to_string())?;
    drop(file);
    fs::rename(&temporary, path).map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "shared_memory_intelligence_tests.rs"]
mod tests;
