//! Local automatic selection. Archived evidence remains available and manual notes are preserved.
use super::*;

pub(super) fn migrate(connection: &Connection) -> Result<()> {
    let version: u32 = connection
        .pragma_query_value(None, "user_version", |r| r.get(0))
        .map_err(db_error)?;
    if version >= 4 {
        return Ok(());
    }
    connection.execute_batch("BEGIN IMMEDIATE;
        CREATE TABLE IF NOT EXISTS memory_curation(project_key TEXT PRIMARY KEY,enabled INTEGER NOT NULL DEFAULT 1,sweep_version INTEGER NOT NULL DEFAULT 0);
        PRAGMA user_version=4; COMMIT;").map_err(db_error)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CurationStatus {
    pub enabled: bool,
    pub selected: usize,
    pub archived: usize,
    pub method: &'static str,
}

impl Engine {
    pub fn curation_enabled(&self, project: &str) -> Result<bool> {
        validate_project(project)?;
        Ok(self
            .connection()?
            .query_row(
                "SELECT enabled FROM memory_curation WHERE project_key=?1",
                [project],
                |r| r.get(0),
            )
            .optional()
            .map_err(db_error)?
            .unwrap_or(true))
    }
    pub fn configure_curation(&self, project: &str, enabled: bool) -> Result<CurationStatus> {
        self.connection()?.execute("INSERT INTO memory_curation(project_key,enabled) VALUES(?1,?2) ON CONFLICT(project_key) DO UPDATE SET enabled=excluded.enabled",params![project,enabled]).map_err(db_error)?;
        self.curate(project)
    }
    pub fn curate(&self, project: &str) -> Result<CurationStatus> {
        let enabled = self.curation_enabled(project)?;
        let config = self.config(project)?;
        if enabled && config.enabled {
            if project == GLOBAL_MEMORY_KEY {
                self.curate_profiles()?;
            } else if config.capture_enabled {
                let mut connection = self.connection()?;
                let tx = connection
                    .transaction_with_behavior(TransactionBehavior::Immediate)
                    .map_err(db_error)?;
                let swept: i64 = tx
                    .query_row(
                        "SELECT sweep_version FROM memory_curation WHERE project_key=?1",
                        [project],
                        |r| r.get(0),
                    )
                    .optional()
                    .map_err(db_error)?
                    .unwrap_or(0);
                if swept < 1 {
                    // One active derived checkpoint per provider/conversation; retain all versions and older notes in Archive.
                    tx.execute("INSERT INTO memory_metadata(memory_id,state,archived_at)
                        SELECT m.id,'archived',?2 FROM memory_records m LEFT JOIN memory_metadata x ON x.memory_id=m.id
                        WHERE m.project_key=?1 AND m.source='capture' AND m.kind='handoff' AND m.pinned=0
                        AND m.source_session_id IS NOT NULL AND m.provider IS NOT NULL AND coalesce(x.state,'active')='active'
                        AND EXISTS(SELECT 1 FROM memory_records n LEFT JOIN memory_metadata nx ON nx.memory_id=n.id
                            WHERE n.project_key=m.project_key AND n.source_session_id=m.source_session_id AND n.provider=m.provider
                            AND n.source='capture' AND n.kind='handoff' AND n.pinned=0 AND coalesce(nx.state,'active')='active'
                            AND (n.updated_at>m.updated_at OR (n.updated_at=m.updated_at AND n.rowid>m.rowid)))
                        ON CONFLICT(memory_id) DO UPDATE SET state='archived',archived_at=excluded.archived_at",params![project,now_ms()]).map_err(db_error)?;
                    tx.execute("INSERT INTO memory_curation(project_key,sweep_version) VALUES(?1,1) ON CONFLICT(project_key) DO UPDATE SET sweep_version=1",[project]).map_err(db_error)?;
                    tx.execute("UPDATE memory_records SET verification='auto-selected',revision=revision+1 WHERE project_key=?1 AND source='capture' AND kind='handoff' AND pinned=0 AND verification='unverified' AND id NOT IN(SELECT memory_id FROM memory_metadata WHERE state<>'active')",[project]).map_err(db_error)?;
                }
                tx.commit().map_err(db_error)?;
            }
        }
        let connection = self.connection()?;
        let selected: i64 = connection.query_row("SELECT count(*) FROM memory_records m LEFT JOIN memory_metadata x ON x.memory_id=m.id WHERE m.project_key=?1 AND m.verification='auto-selected' AND coalesce(x.state,'active')='active'",[project],|r|r.get(0)).map_err(db_error)?;
        let archived: i64 = connection.query_row("SELECT count(*) FROM memory_records m JOIN memory_metadata x ON x.memory_id=m.id WHERE m.project_key=?1 AND m.source='capture' AND x.state='archived'",[project],|r|r.get(0)).map_err(db_error)?;
        Ok(CurationStatus {
            enabled,
            selected: selected as usize,
            archived: archived as usize,
            method: "local-rules",
        })
    }
    pub(super) fn curated_checkpoint(
        &self,
        project: &str,
        session: &str,
        provider: &str,
    ) -> Result<Option<MemoryRecord>> {
        self.curate(project)?;
        self.connection()?.query_row(&format!("SELECT {COLUMNS} FROM memory_records m LEFT JOIN memory_metadata x ON x.memory_id=m.id WHERE m.project_key=?1 AND m.source_session_id=?2 AND m.provider=?3 AND m.source='capture' AND m.kind='handoff' AND m.pinned=0 AND coalesce(x.state,'active')='active' AND coalesce(x.feedback,'')<>'wrong' ORDER BY m.updated_at DESC,m.rowid DESC LIMIT 1"),params![project,session,provider],record_from_row).optional().map_err(db_error)
    }
    pub fn curate_profiles(&self) -> Result<usize> {
        if !self.curation_enabled(GLOBAL_MEMORY_KEY)? || !self.config(GLOBAL_MEMORY_KEY)?.enabled {
            return Ok(0);
        }
        let mut selected = 0;
        for candidate in self
            .profile_candidates()?
            .into_iter()
            .filter(|c| c.status == "candidate" && c.eligible)
        {
            let lower = candidate.statement.to_lowercase();
            // Temporary instructions, addresses, credentials and conflicting preferences stay available for optional review.
            if [
                "neste projeto",
                "nesse projeto",
                "nesta tarefa",
                "por enquanto",
                "this project",
                "this task",
                "for now",
                "@",
                "http",
                "[redacted",
                "[secret",
            ]
            .iter()
            .any(|s| lower.contains(s))
            {
                continue;
            }
            if automatic_profile_conflict(
                &*self.connection()?,
                &candidate.topic,
                &candidate.statement,
            )? {
                continue;
            }
            if self
                .review_profile_impl(&candidate.id, true, true)?
                .is_some()
            {
                selected += 1;
            }
        }
        Ok(selected)
    }
}

pub(super) fn automatic_profile_conflict(
    connection: &Connection,
    topic: &str,
    statement: &str,
) -> Result<bool> {
    let blocked: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM memory_profile_candidates c JOIN memory_records m ON m.id=c.record_id LEFT JOIN memory_metadata x ON x.memory_id=m.id WHERE c.topic=?1 AND c.status='accepted' AND coalesce(x.state,'active')='active' AND (c.statement<>?2 OR m.source='manual'))",params![topic,statement],|r|r.get(0)).map_err(db_error)?;
    if blocked {
        return Ok(true);
    }
    let manual = connection.prepare("SELECT m.title || ' ' || m.content FROM memory_records m LEFT JOIN memory_metadata x ON x.memory_id=m.id WHERE m.project_key=?1 AND m.source='manual' AND coalesce(x.state,'active')='active'").map_err(db_error)?.query_map([GLOBAL_MEMORY_KEY],|r|r.get::<_,String>(0)).map_err(db_error)?.collect::<std::result::Result<Vec<_>,_>>().map_err(db_error)?;
    let markers: &[&str] = match topic {
        "package-manager" => &["pnpm", "npm", "yarn", "bun"],
        "language" => &[
            "portugu", "english", "inglês", "ingles", "español", "espanhol", "language", "idioma",
        ],
        "testing" => &["test", "verific", "validation"],
        _ => &[statement],
    };
    Ok(manual.iter().any(|text| {
        let lower = text.to_lowercase();
        markers
            .iter()
            .any(|marker| lower.contains(&marker.to_lowercase()))
    }))
}

#[cfg(test)]
#[path = "shared_memory_curation_tests.rs"]
mod tests;
