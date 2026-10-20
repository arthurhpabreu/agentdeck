//! Cooperative file reservations. These never prevent filesystem writes.
use rusqlite::{params, Connection, TransactionBehavior};
use serde_json::{json, Value};
use std::{collections::BTreeMap, path::Path, time::SystemTime};

const MAX_PATHS: usize = 20;
const MAX_PATH_BYTES: usize = 1024;
const MAX_PROJECT_CLAIMS: usize = 400;
const MAX_RESPONSE_BYTES: usize = 16 * 1024;
const DEFAULT_TTL_SECONDS: u64 = 600;
const MAX_TTL_SECONDS: u64 = 1800;

#[derive(Clone)]
struct Scope {
    path: String,
    directory: bool,
}

struct Claim {
    member_id: String,
    member_name: String,
    scope: Scope,
    workdir: String,
    expires: i64,
}

fn error(error: rusqlite::Error) -> String {
    format!("Team reservations: {error}")
}

fn now() -> i64 {
    SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

pub(crate) fn init(db: &Connection) -> Result<(), String> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_team_claims (
            project TEXT NOT NULL, member_id TEXT NOT NULL, path TEXT NOT NULL,
            is_directory INTEGER NOT NULL, workdir TEXT NOT NULL, expires INTEGER NOT NULL,
            PRIMARY KEY(project,member_id,path));
         CREATE INDEX IF NOT EXISTS agent_team_claims_expiry ON agent_team_claims(project,expires);
         CREATE INDEX IF NOT EXISTS agent_team_claims_member ON agent_team_claims(member_id);",
    )
    .map_err(error)
}

fn checkout(workdir: &str) -> std::path::PathBuf {
    let path = std::fs::canonicalize(workdir).unwrap_or_else(|_| workdir.into());
    path.ancestors()
        .find(|ancestor| ancestor.join(".git").exists())
        .unwrap_or(&path)
        .to_path_buf()
}

fn checkout_key(workdir: &str) -> String {
    let mut path = checkout(workdir).to_string_lossy().replace('\\', "/");
    if let Some(rest) = path.strip_prefix("//?/UNC/") {
        path = format!("//{rest}");
    } else if let Some(rest) = path.strip_prefix("//?/") {
        path = rest.into();
    }
    #[cfg(any(windows, target_os = "macos"))]
    {
        path = path.to_uppercase().to_lowercase();
    }
    path.trim_end_matches('/').into()
}

fn normalize(path: &str, workdir: &str) -> Result<Scope, String> {
    if path.trim().is_empty() || path.len() > MAX_PATH_BYTES || path.chars().any(char::is_control) {
        return Err(
            "Provide a nonempty relative path of at most 1024 bytes, without control characters."
                .into(),
        );
    }
    let path = path.replace('\\', "/");
    if path.starts_with('/') || path.contains(':') || path.contains(['*', '?']) {
        return Err(
            "Reservation paths must be relative to the repository root, without drives or globs."
                .into(),
        );
    }
    let mut components = Vec::new();
    for component in path.split('/') {
        match component {
            ".." => return Err("Reservation paths cannot contain '..'.".into()),
            "" | "." => {}
            value => components.push(value),
        }
    }
    if components.is_empty() {
        return Err("Choose a file or directory inside the repository.".into());
    }
    let mut normalized = components.join("/");
    let directory = path.ends_with('/') || checkout(workdir).join(&normalized).is_dir();
    #[cfg(any(windows, target_os = "macos"))]
    {
        // Include Unicode case pairs such as accented Portuguese names and the
        // dotless i. Windows and macOS volumes can treat these as the same file.
        // Also fold on case-sensitive Mac volumes: an extra cooperative overlap
        // is preferable to bypassing a reservation on case-insensitive APFS.
        normalized = normalized.to_uppercase().to_lowercase();
    }
    Ok(Scope {
        path: normalized,
        directory,
    })
}

fn scopes(input: &Value, workdir: &str, required: bool) -> Result<Option<Vec<Scope>>, String> {
    let Some(paths) = input.get("paths") else {
        return if required {
            Err("Provide paths to reserve.".into())
        } else {
            Ok(None)
        };
    };
    let paths = paths
        .as_array()
        .ok_or("Paths must be an array of strings.")?;
    if paths.len() > MAX_PATHS || (required && paths.is_empty()) {
        return Err("Reserve between one and 20 paths at a time.".into());
    }
    let mut normalized = BTreeMap::<String, bool>::new();
    for path in paths {
        let scope = normalize(path.as_str().ok_or("Each path must be a string.")?, workdir)?;
        normalized
            .entry(scope.path)
            .and_modify(|directory| *directory |= scope.directory)
            .or_insert(scope.directory);
    }
    Ok(Some(
        normalized
            .into_iter()
            .map(|(path, directory)| Scope { path, directory })
            .collect(),
    ))
}

fn overlaps(first: &Scope, second: &Scope) -> bool {
    first.path == second.path
        || (first.directory && second.path.starts_with(&format!("{}/", first.path)))
        || (second.directory && first.path.starts_with(&format!("{}/", second.path)))
}

fn active_member(db: &Connection, project: &str, member: &str) -> Result<(), String> {
    let enabled: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM agent_team_members m
             JOIN coordination_sessions s ON s.project=m.project AND s.id=m.session_id
             WHERE m.id=?1 AND m.project=?2 AND s.enabled=1)",
            params![member, project],
            |row| row.get(0),
        )
        .map_err(error)?;
    if !enabled {
        return Err("This chat is no longer an enabled member of the team.".into());
    }
    Ok(())
}

fn active(db: &Connection, project: &str, at: i64) -> Result<Vec<Claim>, String> {
    let mut statement = db
        .prepare(
            "SELECT c.member_id,s.name,c.path,c.is_directory,c.workdir,c.expires
             FROM agent_team_claims c
             JOIN agent_team_members m ON m.id=c.member_id AND m.project=c.project
             JOIN coordination_sessions s ON s.project=m.project AND s.id=m.session_id
             WHERE c.project=?1 AND c.expires>?2 AND s.enabled=1
             ORDER BY c.expires DESC,c.member_id,c.path LIMIT ?3",
        )
        .map_err(error)?;
    let claims = statement
        .query_map(
            params![project, at, (MAX_PROJECT_CLAIMS + 1) as i64],
            |row| {
                Ok(Claim {
                    member_id: row.get(0)?,
                    member_name: row.get(1)?,
                    scope: Scope {
                        path: row.get(2)?,
                        directory: row.get(3)?,
                    },
                    workdir: row.get(4)?,
                    expires: row.get(5)?,
                })
            },
        )
        .map_err(error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(error)?;
    Ok(claims)
}

fn excerpt(text: &str, max: usize) -> String {
    if text.len() <= max {
        return text.into();
    }
    let mut end = max.saturating_sub('…'.len_utf8());
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &text[..end])
}

fn row(claim: &Claim, workdir: Option<&str>) -> Value {
    let path = if claim.scope.directory {
        format!("{}/", claim.scope.path)
    } else {
        claim.scope.path.clone()
    };
    let mut result = json!({
        "memberId":claim.member_id,
        "memberName":excerpt(&claim.member_name,256),
        "path":path,
        "workdir":excerpt(&claim.workdir,1024),
        "expiresAt":claim.expires
    });
    if let Some(workdir) = workdir {
        result["kind"] = json!(if checkout_key(workdir) == checkout_key(&claim.workdir) {
            "same_checkout"
        } else {
            "merge"
        });
    }
    result
}

fn response(claims: &[Claim], workdir: Option<&str>, acquired: Option<bool>) -> Value {
    let key = if acquired == Some(false) {
        "conflicts"
    } else {
        "claims"
    };
    let mut result = json!({"advisory":true,"hasMore":false,"count":claims.len()});
    if let Some(acquired) = acquired {
        result["acquired"] = json!(acquired);
    }
    result[key] = json!([]);
    for claim in claims {
        let encoded = row(claim, workdir);
        result[key].as_array_mut().unwrap().push(encoded);
        if result.to_string().len() > MAX_RESPONSE_BYTES - 64 {
            result[key].as_array_mut().unwrap().pop();
            result["hasMore"] = json!(true);
            break;
        }
    }
    result
}

pub(crate) fn list(db: &Connection, project: &str) -> Result<Value, String> {
    Ok(response(&active(db, project, now())?, None, None))
}

pub(crate) fn release_member(db: &Connection, member_id: &str) -> Result<(), String> {
    db.execute(
        "DELETE FROM agent_team_claims WHERE member_id=?1",
        [member_id],
    )
    .map_err(error)?;
    Ok(())
}

pub(crate) fn call(
    db: &mut Connection,
    project: &str,
    member_id: &str,
    workdir: &str,
    name: &str,
    input: &Value,
) -> Result<Value, String> {
    if member_id.is_empty()
        || member_id.len() > 256
        || project.is_empty()
        || project.len() > 4096
        || workdir.is_empty()
        || workdir.len() > 4096
    {
        return Err("Invalid reservation membership context.".into());
    }
    match name {
        "team_claim" => {
            let paths = scopes(input, workdir, true)?.unwrap();
            let ttl = match input.get("ttlSeconds") {
                Some(value) => value
                    .as_u64()
                    .filter(|ttl| (1..=MAX_TTL_SECONDS).contains(ttl))
                    .ok_or("ttlSeconds must be an integer between one and 1800.")?,
                None => DEFAULT_TTL_SECONDS,
            };
            let at = now();
            let expires = at.saturating_add((ttl * 1000) as i64);
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(error)?;
            active_member(&tx, project, member_id)?;
            tx.execute("DELETE FROM agent_team_claims WHERE expires<=?1", [at])
                .map_err(error)?;
            let existing = active(&tx, project, at)?;
            if existing.len() > MAX_PROJECT_CLAIMS {
                return Err("This project has too many active reservations.".into());
            }
            let conflicts: Vec<_> = existing
                .iter()
                .filter(|claim| {
                    claim.member_id != member_id
                        && paths.iter().any(|scope| overlaps(scope, &claim.scope))
                })
                .collect();
            if !conflicts.is_empty() {
                let rows: Vec<_> = conflicts
                    .into_iter()
                    .map(|claim| Claim {
                        member_id: claim.member_id.clone(),
                        member_name: claim.member_name.clone(),
                        scope: claim.scope.clone(),
                        workdir: claim.workdir.clone(),
                        expires: claim.expires,
                    })
                    .collect();
                let result = response(&rows, Some(workdir), Some(false));
                tx.commit().map_err(error)?;
                return Ok(result);
            }
            let own = existing
                .iter()
                .filter(|claim| claim.member_id == member_id)
                .count();
            let additions = paths
                .iter()
                .filter(|scope| {
                    !existing
                        .iter()
                        .any(|claim| claim.member_id == member_id && claim.scope.path == scope.path)
                })
                .count();
            if own + additions > MAX_PATHS || existing.len() + additions > MAX_PROJECT_CLAIMS {
                return Err(
                    "Reservation capacity reached. Release finished paths before reserving more."
                        .into(),
                );
            }
            for scope in &paths {
                tx.execute(
                    "INSERT INTO agent_team_claims(project,member_id,path,is_directory,workdir,expires)
                     VALUES(?1,?2,?3,?4,?5,?6)
                     ON CONFLICT(project,member_id,path) DO UPDATE SET
                     is_directory=excluded.is_directory,workdir=excluded.workdir,expires=excluded.expires",
                    params![project,member_id,scope.path,scope.directory,workdir,expires],
                )
                .map_err(error)?;
            }
            let renewed: Vec<_> = active(&tx, project, at)?
                .into_iter()
                .filter(|claim| {
                    claim.member_id == member_id
                        && paths.iter().any(|scope| scope.path == claim.scope.path)
                })
                .collect();
            let result = response(&renewed, Some(workdir), Some(true));
            tx.commit().map_err(error)?;
            Ok(result)
        }
        "team_release" => {
            let paths = scopes(input, workdir, false)?;
            let tx = db
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(error)?;
            active_member(&tx, project, member_id)?;
            let mut released = 0;
            if let Some(paths) = paths {
                for path in paths {
                    released += tx
                        .execute(
                            "DELETE FROM agent_team_claims WHERE project=?1 AND member_id=?2 AND path=?3",
                            params![project,member_id,path.path],
                        )
                        .map_err(error)?;
                }
            } else {
                released = tx
                    .execute(
                        "DELETE FROM agent_team_claims WHERE project=?1 AND member_id=?2",
                        params![project, member_id],
                    )
                    .map_err(error)?;
            }
            tx.commit().map_err(error)?;
            Ok(json!({"released":released}))
        }
        _ => Err("Unknown team reservation tool.".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        path::PathBuf,
        sync::{Arc, Barrier},
        time::Duration,
    };

    struct Fixture {
        directory: PathBuf,
        repository: PathBuf,
        worktree: PathBuf,
        other: PathBuf,
    }

    impl Fixture {
        fn new() -> Self {
            let directory =
                std::env::temp_dir().join(format!("agentdeck-claims-{}", uuid::Uuid::new_v4()));
            let repository = directory.join("repository");
            let worktree = directory.join("worktree");
            let other = directory.join("other");
            let gitdir = repository.join(".git/worktrees/worktree");
            std::fs::create_dir_all(&gitdir).unwrap();
            std::fs::create_dir_all(repository.join("src")).unwrap();
            std::fs::create_dir_all(&worktree).unwrap();
            std::fs::create_dir_all(other.join(".git")).unwrap();
            std::fs::write(
                worktree.join(".git"),
                format!("gitdir: {}", gitdir.to_string_lossy()),
            )
            .unwrap();
            std::fs::write(
                gitdir.join("gitdir"),
                worktree.join(".git").to_string_lossy().as_bytes(),
            )
            .unwrap();
            std::fs::write(gitdir.join("commondir"), "../..").unwrap();
            Self {
                directory,
                repository,
                worktree,
                other,
            }
        }

        fn db(&self) -> Connection {
            let db = Connection::open(self.directory.join("claims.sqlite3")).unwrap();
            db.busy_timeout(Duration::from_secs(5)).unwrap();
            db.execute_batch("CREATE TABLE IF NOT EXISTS agent_team_members(id TEXT PRIMARY KEY,team_id TEXT,project TEXT,session_id TEXT);
                CREATE TABLE IF NOT EXISTS coordination_sessions(project TEXT,id TEXT,name TEXT,workdir TEXT,enabled INTEGER,updated INTEGER,PRIMARY KEY(project,id));").unwrap();
            init(&db).unwrap();
            db
        }

        fn member(&self, db: &Connection, project: &str, id: &str, workdir: &Path) {
            db.execute("INSERT INTO agent_team_members(id,team_id,project,session_id) VALUES(?1,'team',?2,?1)", params![id,project]).unwrap();
            db.execute("INSERT INTO coordination_sessions(project,id,name,workdir,enabled,updated) VALUES(?1,?2,?2,?3,1,?4)",params![project,id,workdir.to_string_lossy(),now()]).unwrap();
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            std::fs::remove_dir_all(&self.directory).unwrap();
        }
    }

    fn claim(
        db: &mut Connection,
        project: &str,
        member: &str,
        workdir: &Path,
        paths: Value,
    ) -> Value {
        call(
            db,
            project,
            member,
            &workdir.to_string_lossy(),
            "team_claim",
            &json!({"paths":paths}),
        )
        .unwrap()
    }

    #[test]
    fn directory_conflicts_are_atomic_and_follow_path_segments() {
        let fixture = Fixture::new();
        let project = crate::shared_memory::project_key(&fixture.repository).unwrap();
        let mut db = fixture.db();
        fixture.member(&db, &project, "one", &fixture.repository);
        fixture.member(&db, &project, "two", &fixture.repository);
        assert_eq!(
            claim(
                &mut db,
                &project,
                "one",
                &fixture.repository,
                json!(["./src\\"])
            )["acquired"],
            true
        );
        let conflict = claim(
            &mut db,
            &project,
            "two",
            &fixture.repository,
            json!(["tests/new.rs", "src/api.rs"]),
        );
        assert_eq!(conflict["acquired"], false);
        assert_eq!(conflict["conflicts"][0]["kind"], "same_checkout");
        assert_eq!(conflict["conflicts"][0]["path"], "src/");
        assert_eq!(conflict["conflicts"][0]["memberName"], "one");
        assert_eq!(list(&db, &project).unwrap()["count"], 1);
        assert_eq!(
            claim(
                &mut db,
                &project,
                "two",
                &fixture.repository,
                json!(["src-two/api.rs"])
            )["acquired"],
            true
        );
        // Existing directories need not have an explicit trailing separator.
        assert_eq!(
            normalize("src", &fixture.repository.to_string_lossy())
                .unwrap()
                .directory,
            true
        );
        #[cfg(any(windows, target_os = "macos"))]
        {
            assert_eq!(
                claim(
                    &mut db,
                    &project,
                    "two",
                    &fixture.repository,
                    json!(["SRC/API.RS"])
                )["acquired"],
                false
            );
            claim(
                &mut db,
                &project,
                "one",
                &fixture.repository,
                json!(["Árvore.rs", "I.rs"]),
            );
            for path in ["árvore.rs", "ı.rs"] {
                assert_eq!(
                    claim(&mut db, &project, "two", &fixture.repository, json!([path]))["acquired"],
                    false
                );
            }
        }
    }

    #[test]
    fn worktrees_conflict_logically_but_other_projects_do_not() {
        let fixture = Fixture::new();
        let project = crate::shared_memory::project_key(&fixture.repository).unwrap();
        assert_eq!(
            project,
            crate::shared_memory::project_key(&fixture.worktree).unwrap()
        );
        let other = crate::shared_memory::project_key(&fixture.other).unwrap();
        assert_ne!(project, other);
        let mut db = fixture.db();
        fixture.member(&db, &project, "one", &fixture.repository);
        fixture.member(&db, &project, "two", &fixture.worktree);
        fixture.member(&db, &other, "three", &fixture.other);
        assert_eq!(
            claim(
                &mut db,
                &project,
                "one",
                &fixture.repository,
                json!(["src/api.rs"])
            )["acquired"],
            true
        );
        let conflict = claim(
            &mut db,
            &project,
            "two",
            &fixture.worktree,
            json!(["src/api.rs"]),
        );
        assert_eq!(conflict["acquired"], false);
        assert_eq!(conflict["conflicts"][0]["kind"], "merge");
        assert_eq!(
            claim(
                &mut db,
                &other,
                "three",
                &fixture.other,
                json!(["src/api.rs"])
            )["acquired"],
            true
        );
        db.execute(
            "UPDATE agent_team_members SET team_id='different-team' WHERE id='two'",
            [],
        )
        .unwrap();
        assert_eq!(
            claim(
                &mut db,
                &project,
                "two",
                &fixture.worktree,
                json!(["src/api.rs"])
            )["acquired"],
            false
        );
    }

    #[test]
    fn heartbeat_does_not_extend_a_lease_and_owners_renew_or_release_their_own_paths() {
        let fixture = Fixture::new();
        let project = crate::shared_memory::project_key(&fixture.repository).unwrap();
        let mut db = fixture.db();
        fixture.member(&db, &project, "one", &fixture.repository);
        fixture.member(&db, &project, "two", &fixture.repository);
        claim(
            &mut db,
            &project,
            "one",
            &fixture.repository,
            json!(["src/api.rs"]),
        );
        let fixed = now() + 60_000;
        db.execute("UPDATE agent_team_claims SET expires=?1", [fixed])
            .unwrap();
        db.execute("UPDATE coordination_sessions SET updated=?1", [now()])
            .unwrap();
        let expires: i64 = db
            .query_row("SELECT expires FROM agent_team_claims", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(expires, fixed);
        let renewed = call(
            &mut db,
            &project,
            "one",
            &fixture.repository.to_string_lossy(),
            "team_claim",
            &json!({"paths":["src/api.rs"],"ttlSeconds":1800}),
        )
        .unwrap();
        assert!(renewed["claims"][0]["expiresAt"].as_i64().unwrap() > fixed);
        assert_eq!(
            call(
                &mut db,
                &project,
                "two",
                &fixture.repository.to_string_lossy(),
                "team_release",
                &json!({"paths":["src/api.rs"]})
            )
            .unwrap()["released"],
            0
        );
        db.execute("UPDATE agent_team_claims SET expires=?1", [now() - 1])
            .unwrap();
        db.execute("UPDATE coordination_sessions SET updated=?1", [now()])
            .unwrap();
        assert_eq!(
            claim(
                &mut db,
                &project,
                "two",
                &fixture.repository,
                json!(["src/api.rs"])
            )["acquired"],
            true
        );
        release_member(&db, "one").unwrap();
        assert_eq!(list(&db, &project).unwrap()["count"], 1);
        assert_eq!(
            call(
                &mut db,
                &project,
                "two",
                &fixture.repository.to_string_lossy(),
                "team_release",
                &json!({})
            )
            .unwrap()["released"],
            1
        );
        assert_eq!(list(&db, &project).unwrap()["count"], 0);
    }

    #[test]
    fn disabled_or_removed_members_cannot_recreate_reservations() {
        let fixture = Fixture::new();
        let project = crate::shared_memory::project_key(&fixture.repository).unwrap();
        let mut db = fixture.db();
        fixture.member(&db, &project, "one", &fixture.repository);
        claim(
            &mut db,
            &project,
            "one",
            &fixture.repository,
            json!(["src/api.rs"]),
        );
        db.execute("UPDATE coordination_sessions SET enabled=0", [])
            .unwrap();
        release_member(&db, "one").unwrap();
        let input = json!({"paths":["src/api.rs"]});
        assert!(call(
            &mut db,
            &project,
            "one",
            &fixture.repository.to_string_lossy(),
            "team_claim",
            &input
        )
        .is_err());
        db.execute("UPDATE coordination_sessions SET enabled=1", [])
            .unwrap();
        db.execute("DELETE FROM agent_team_members", []).unwrap();
        assert!(call(
            &mut db,
            &project,
            "one",
            &fixture.repository.to_string_lossy(),
            "team_claim",
            &input
        )
        .is_err());
        assert_eq!(list(&db, &project).unwrap()["count"], 0);
    }

    #[test]
    fn invalid_paths_ttls_and_capacity_do_not_partially_change_claims() {
        let fixture = Fixture::new();
        let project = crate::shared_memory::project_key(&fixture.repository).unwrap();
        let mut db = fixture.db();
        fixture.member(&db, &project, "one", &fixture.repository);
        for path in [
            "",
            " ",
            "/tmp/file",
            "C:\\file",
            "../file",
            "src/../file",
            ".",
            "src/*",
            "src/??",
            "src/\nfile",
        ] {
            assert!(
                call(
                    &mut db,
                    &project,
                    "one",
                    &fixture.repository.to_string_lossy(),
                    "team_claim",
                    &json!({"paths":["valid.rs",path]})
                )
                .is_err(),
                "{path:?}"
            );
        }
        for ttl in [json!(0), json!(-1), json!(1801), json!(1.5), json!("600")] {
            assert!(call(
                &mut db,
                &project,
                "one",
                &fixture.repository.to_string_lossy(),
                "team_claim",
                &json!({"paths":["valid.rs"],"ttlSeconds":ttl})
            )
            .is_err());
        }
        assert!(call(
            &mut db,
            &project,
            "one",
            &fixture.repository.to_string_lossy(),
            "team_claim",
            &json!({"paths":["x".repeat(1025)]})
        )
        .is_err());
        assert_eq!(list(&db, &project).unwrap()["count"], 0);
        let paths: Vec<_> = (0..20).map(|n| format!("file-{n}.rs")).collect();
        assert_eq!(
            claim(&mut db, &project, "one", &fixture.repository, json!(paths))["count"],
            20
        );
        assert!(call(
            &mut db,
            &project,
            "one",
            &fixture.repository.to_string_lossy(),
            "team_claim",
            &json!({"paths":["extra.rs"]})
        )
        .is_err());
        assert_eq!(list(&db, &project).unwrap()["count"], 20);
    }

    #[test]
    fn encoded_responses_stay_bounded_and_report_truncation() {
        let fixture = Fixture::new();
        let project = crate::shared_memory::project_key(&fixture.repository).unwrap();
        let mut db = fixture.db();
        fixture.member(&db, &project, "one", &fixture.repository);
        fixture.member(&db, &project, "two", &fixture.repository);
        db.execute(
            "UPDATE coordination_sessions SET name=?1",
            ["🦀\"".repeat(64)],
        )
        .unwrap();
        let paths: Vec<_> = (0..20)
            .map(|n| format!("{n}{}", "🦀\"".repeat(200)))
            .collect();
        let acquired = claim(&mut db, &project, "one", &fixture.repository, json!(paths));
        assert_eq!(acquired["acquired"], true);
        assert_eq!(acquired["count"], 20);
        assert_eq!(acquired["hasMore"], true);
        assert!(acquired.to_string().len() <= MAX_RESPONSE_BYTES);
        let listed = list(&db, &project).unwrap();
        assert!(listed.to_string().len() <= MAX_RESPONSE_BYTES);
        assert_eq!(listed["hasMore"], true);
        let conflicts = claim(&mut db, &project, "two", &fixture.repository, json!(paths));
        assert_eq!(conflicts["acquired"], false);
        assert_eq!(conflicts["count"], 20);
        assert_eq!(conflicts["hasMore"], true);
        assert!(conflicts.to_string().len() <= MAX_RESPONSE_BYTES);
    }

    #[test]
    fn concurrent_acquisitions_have_only_one_winner() {
        let fixture = Fixture::new();
        let project = crate::shared_memory::project_key(&fixture.repository).unwrap();
        let db = fixture.db();
        fixture.member(&db, &project, "one", &fixture.repository);
        fixture.member(&db, &project, "two", &fixture.repository);
        drop(db);
        let barrier = Arc::new(Barrier::new(2));
        let handles: Vec<_> = ["one", "two"]
            .into_iter()
            .map(|member| {
                let path = fixture.directory.join("claims.sqlite3");
                let project = project.clone();
                let workdir = fixture.repository.clone();
                let barrier = barrier.clone();
                std::thread::spawn(move || {
                    let mut db = Connection::open(path).unwrap();
                    db.busy_timeout(Duration::from_secs(5)).unwrap();
                    barrier.wait();
                    claim(&mut db, &project, member, &workdir, json!(["src/api.rs"]))["acquired"]
                        .as_bool()
                        .unwrap()
                })
            })
            .collect();
        assert_eq!(
            handles
                .into_iter()
                .map(|handle| handle.join().unwrap())
                .filter(|acquired| *acquired)
                .count(),
            1
        );
        let db = fixture.db();
        assert_eq!(list(&db, &project).unwrap()["count"], 1);
    }
}
