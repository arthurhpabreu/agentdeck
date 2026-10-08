use super::*;
use crate::shared_memory::{MemoryDraft, MemoryMetadata};
use std::fs;
fn fixture() -> (std::path::PathBuf, Engine, String, std::path::PathBuf) {
    let root = std::env::temp_dir().join(format!("agentdeck-retrieval-{}", uuid::Uuid::new_v4()));
    fs::create_dir_all(root.join("docs")).unwrap();
    let engine = Engine::open(&root).unwrap();
    let project = engine
        .register_project(root.to_str().unwrap(), None)
        .unwrap();
    let config = root.join("knowledge.json");
    fs::write(
        &config,
        serde_json::json!({"sourcePath":root.join("docs").to_string_lossy()}).to_string(),
    )
    .unwrap();
    (root, engine, project, config)
}
#[test]
fn automatic_queries_obey_byte_limit_and_preserve_utf8_and_both_ends() {
    for query in [String::new(), "ação 🚀".into(), "x".repeat(MAX_QUERY_BYTES)] {
        assert!(matches!(
            automatic_query(&query),
            std::borrow::Cow::Borrowed(_)
        ));
        assert_eq!(automatic_query(&query), query);
    }
    for padding in ["x", "ç", "🚀"] {
        let query = format!(
            "Opening context\n{}\nFinal request",
            padding.repeat(MAX_QUERY_BYTES)
        );
        let bounded = automatic_query(&query);
        assert!(bounded.len() <= MAX_QUERY_BYTES);
        assert!(bounded.starts_with("Opening context\n"));
        assert!(bounded.ends_with("\nFinal request"));
    }
    assert_eq!(
        automatic_query(&"x".repeat(MAX_QUERY_BYTES + 1)).len(),
        MAX_QUERY_BYTES
    );
}

#[test]
fn large_prompts_retrieve_project_memory_and_global_vault_without_changing_prompt() {
    let (root, engine, project, config) = fixture();
    fs::create_dir(root.join("docs/.obsidian")).unwrap();
    fs::write(
        root.join("docs/renewal.md"),
        "# Renewal\nCheck refresh token expiry.",
    )
    .unwrap();
    let record = engine
        .save(
            &project,
            &MemoryDraft {
                id: None,
                title: "OAuth".into(),
                content: "Use typed authentication errors.".into(),
                kind: "decision".into(),
                pinned: false,
            },
            None,
            None,
        )
        .unwrap();
    let query = format!("OAuth\n{}\nrenewal", "ação 🚀 ".repeat(6000));
    let original = query.clone();
    assert!(query.len() > MAX_QUERY_BYTES);
    // Explicit search limits still apply to UI and MCP callers.
    assert_eq!(
        search(
            &engine,
            &project,
            Some(root.to_str().unwrap()),
            Some(&config),
            &query
        )
        .err()
        .as_deref(),
        Some("Query exceeds limit")
    );
    let prepared = prepare(
        &engine,
        &project,
        root.to_str().unwrap(),
        &config,
        "codex:large",
        &query,
        (3, 1400),
    )
    .unwrap();
    assert_eq!(query, original);
    assert!(prepared.hits.iter().any(|hit| hit.id == record.id));
    assert!(prepared
        .hits
        .iter()
        .any(|hit| hit.source == "document" && hit.scope == "global" && hit.title == "Renewal"));
    assert!(!prepared.prepared.text.is_empty());
    assert!(prepared.prepared.text.len() <= engine.config(&project).unwrap().budget_tokens * 4);
    engine
        .mark_delivered(&project, "codex:large", &prepared.prepared)
        .unwrap();
    for reference in &prepared.references {
        engine
            .mark_reference_delivered(&project, "codex:large", reference, 1)
            .unwrap();
    }
    let repeated = prepare(
        &engine,
        &project,
        root.to_str().unwrap(),
        &config,
        "codex:large",
        &query,
        (3, 1400),
    )
    .unwrap();
    assert!(repeated.prepared.text.is_empty());
    assert!(repeated.prepared.duplicate_count >= 2);
    let command = format!("/compact {query}");
    assert!(prepare(
        &engine,
        &project,
        root.to_str().unwrap(),
        &config,
        "codex:command",
        &command,
        (3, 1400)
    )
    .unwrap()
    .prepared
    .text
    .is_empty());
}

#[test]
fn mixed_context_obeys_budget_and_delivery_without_cross_project_leaks() {
    let (root, engine, project, config) = fixture();
    fs::write(
        root.join("docs/auth.md"),
        "# Authentication\nOAuth tokens use rotating secrets. [[checks]]",
    )
    .unwrap();
    fs::write(
        root.join("docs/checks.md"),
        "# Checks\nVerify renewal boundaries.",
    )
    .unwrap();
    engine
        .save(
            &project,
            &MemoryDraft {
                id: None,
                title: "OAuth authentication".into(),
                content: "Use typed authentication errors.".into(),
                kind: "decision".into(),
                pinned: false,
            },
            None,
            None,
        )
        .unwrap();
    engine
        .save(
            "other",
            &MemoryDraft {
                id: None,
                title: "OAuth authentication".into(),
                content: "OTHER_PROJECT_PRIVATE".into(),
                kind: "decision".into(),
                pinned: false,
            },
            None,
            None,
        )
        .unwrap();
    let hits = search(
        &engine,
        &project,
        Some(root.to_str().unwrap()),
        Some(&config),
        "OAuth authentication",
    )
    .unwrap();
    assert!(hits.iter().any(|h| h.source == "memory"));
    assert!(hits.iter().any(|h| h.source == "document"));
    assert!(hits.iter().any(|h| h.reason.contains("one hop")));
    assert!(!hits
        .iter()
        .any(|h| h.excerpt.contains("OTHER_PROJECT_PRIVATE")));
    let prepared = prepare(
        &engine,
        &project,
        root.to_str().unwrap(),
        &config,
        "codex:one",
        "OAuth authentication",
        (3, 1400),
    )
    .unwrap();
    assert!(prepared.prepared.text.len() <= 3200);
    assert!(!prepared.prepared.text.is_empty());
    engine
        .mark_delivered(&project, "codex:one", &prepared.prepared)
        .unwrap();
    for id in &prepared.references {
        engine
            .mark_reference_delivered(&project, "codex:one", id, 1)
            .unwrap();
    }
    let repeated = prepare(
        &engine,
        &project,
        root.to_str().unwrap(),
        &config,
        "codex:one",
        "OAuth authentication",
        (3, 1400),
    )
    .unwrap();
    assert!(repeated.prepared.duplicate_count > 0);
    assert!(repeated
        .hits
        .iter()
        .all(|h| !prepared.hits.iter().any(|p| p.id == h.id)));
}
#[test]
fn archived_and_wrong_notes_do_not_enter_automatic_context() {
    let (root, engine, project, config) = fixture();
    let record = engine
        .save(
            &project,
            &MemoryDraft {
                id: None,
                title: "Authentication".into(),
                content: "Outdated auth decision".into(),
                kind: "decision".into(),
                pinned: true,
            },
            None,
            None,
        )
        .unwrap();
    engine
        .set_metadata(
            &project,
            &record.id,
            &MemoryMetadata {
                feedback: "wrong".into(),
                ..MemoryMetadata::default()
            },
        )
        .unwrap();
    assert!(prepare(
        &engine,
        &project,
        root.to_str().unwrap(),
        &config,
        "codex:test",
        "authentication",
        (3, 1400)
    )
    .unwrap()
    .prepared
    .text
    .is_empty());
}
#[test]
fn selected_document_is_scoped_utf8_safe_and_rechecked_on_read() {
    let (root, _engine, _project, config) = fixture();
    fs::write(root.join("docs/guide.md"), "# OAuth\nAção 🚀 renewal").unwrap();
    let hits =
        crate::knowledge::search_documents(&config, Some(root.to_str().unwrap()), "OAuth", true)
            .unwrap();
    let hit = &hits[0];
    let text = crate::knowledge::read_document(
        &config,
        Some(root.to_str().unwrap()),
        &hit.id,
        true,
        14,
        400,
    )
    .unwrap();
    assert!(text.len() <= 400);
    assert!(crate::knowledge::read_document(
        &config,
        Some(root.to_str().unwrap()),
        &hit.id,
        false,
        0,
        400
    )
    .is_err());
    assert!(crate::knowledge::read_document(
        &config,
        Some(root.to_str().unwrap()),
        "doc:[\"global\",\"../outside.md\"]",
        true,
        0,
        400
    )
    .is_err());
    fs::remove_file(root.join("docs/guide.md")).unwrap();
    assert!(crate::knowledge::read_document(
        &config,
        Some(root.to_str().unwrap()),
        &hit.id,
        true,
        0,
        400
    )
    .is_err());
}
