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
