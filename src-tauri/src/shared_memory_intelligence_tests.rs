use super::*;
fn sandbox() -> (PathBuf, Engine) {
    let root = std::env::temp_dir().join(format!(
        "agentdeck-intelligence-test-{}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir_all(&root).unwrap();
    let engine = Engine::open(&root).unwrap();
    engine.configure_curation(GLOBAL_MEMORY_KEY, false).unwrap();
    (root, engine)
}
fn draft(text: &str) -> MemoryDraft {
    MemoryDraft {
        id: None,
        title: "Test decision".into(),
        content: text.into(),
        kind: "decision".into(),
        pinned: false,
    }
}
#[test]
fn identity_migrates_legacy_records_and_does_not_merge_checkouts() {
    let (root, engine) = sandbox();
    let path = project_key(&root).unwrap();
    let note = engine
        .save(&path, &draft("Keep SQLite"), None, None)
        .unwrap();
    let id = engine.register_project(&path, Some("One")).unwrap();
    assert_eq!(
        engine.get(&id, &note.id).unwrap().unwrap().content,
        "Keep SQLite"
    );
    assert!(engine.get(&path, &note.id).unwrap().is_none());
    assert_eq!(engine.register_project(&path, None).unwrap(), id);
    let checkout = root.join("other");
    fs::create_dir(&checkout).unwrap();
    let other = engine
        .register_project(checkout.to_str().unwrap(), None)
        .unwrap();
    assert_ne!(other, id);
    engine
        .attach_project_path(&id, checkout.to_str().unwrap())
        .unwrap();
    assert_eq!(
        engine
            .register_project(checkout.to_str().unwrap(), None)
            .unwrap(),
        id
    );
}
#[test]
fn preferences_require_review_and_respect_applicability() {
    let (root, engine) = sandbox();
    fs::write(root.join("package.json"), "{}").unwrap();
    let id = engine
        .register_project(root.to_str().unwrap(), None)
        .unwrap();
    let event = MemoryEvent {
        id: "one".into(),
        kind: "prompt".into(),
        title: "Preference".into(),
        summary: "Por padrão prefiro pnpm em todos os meus projetos".into(),
        files: vec![],
        branch: String::new(),
    };
    assert!(engine
        .record_event(&id, "session", "codex", &event)
        .unwrap());
    assert!(!engine
        .record_event(&id, "session", "codex", &event)
        .unwrap());
    assert!(engine.list(GLOBAL_MEMORY_KEY, "").unwrap().is_empty());
    let candidate = engine.profile_candidates().unwrap().remove(0);
    assert!(candidate.eligible);
    let note = engine.review_profile(&candidate.id, true).unwrap().unwrap();
    assert!(engine.applies(&id, &note).unwrap());
    let mut settings = engine.settings(&id).unwrap();
    settings.consume = false;
    engine
        .update_project(&id, "Project", "", &settings)
        .unwrap();
    assert!(!engine.applies(&id, &note).unwrap());
    assert!(engine.review_profile(&candidate.id, true).is_err());
}

#[test]
fn recurring_preferences_respect_contribution_and_preserve_manual_edits() {
    let (root, engine) = sandbox();
    let first = engine
        .register_project(root.to_str().unwrap(), None)
        .unwrap();
    let other = root.join("other");
    fs::create_dir(&other).unwrap();
    let second = engine
        .register_project(other.to_str().unwrap(), None)
        .unwrap();
    let prompt = |id: &str, text: &str| MemoryEvent {
        id: id.into(),
        kind: "prompt".into(),
        title: "Preference".into(),
        summary: text.into(),
        files: vec![],
        branch: String::new(),
    };
    for project in [&first, &second] {
        engine
            .record_event(
                project,
                "s",
                "codex",
                &prompt("pnpm", "Prefiro pnpm para dependências"),
            )
            .unwrap();
    }
    let candidate = engine.profile_candidates().unwrap().remove(0);
    assert_eq!(candidate.project_count, 2);
    assert!(candidate.eligible);
    let mut settings = engine.settings(&second).unwrap();
    settings.contribute = false;
    engine
        .update_project(&second, "Other", "", &settings)
        .unwrap();
    let candidate = engine.profile_candidates().unwrap().remove(0);
    assert_eq!(candidate.project_count, 1);
    assert!(!candidate.eligible);
    let approved = engine.review_profile(&candidate.id, true).unwrap().unwrap();
    engine
        .save(
            GLOBAL_MEMORY_KEY,
            &MemoryDraft {
                id: Some(approved.id.clone()),
                title: "Manual preference".into(),
                content: "User-curated replacement statement".into(),
                kind: "fact".into(),
                pinned: true,
            },
            None,
            None,
        )
        .unwrap();
    engine
        .record_event(
            &first,
            "s",
            "codex",
            &prompt("npm", "Prefiro npm para dependências"),
        )
        .unwrap();
    let next = engine
        .profile_candidates()
        .unwrap()
        .into_iter()
        .find(|c| c.status == "candidate")
        .unwrap();
    engine.review_profile(&next.id, true).unwrap();
    assert_eq!(
        engine
            .metadata(GLOBAL_MEMORY_KEY, &approved.id)
            .unwrap()
            .state,
        "active"
    );
    assert_eq!(
        engine
            .get(GLOBAL_MEMORY_KEY, &approved.id)
            .unwrap()
            .unwrap()
            .content,
        "User-curated replacement statement"
    );
    let unedited = engine
        .profile_candidates()
        .unwrap()
        .into_iter()
        .find(|c| c.id == next.id)
        .unwrap()
        .record_id
        .unwrap();
    engine
        .record_event(
            &first,
            "s",
            "codex",
            &prompt("yarn", "Prefiro yarn para dependências"),
        )
        .unwrap();
    let last = engine
        .profile_candidates()
        .unwrap()
        .into_iter()
        .find(|c| c.status == "candidate")
        .unwrap();
    engine.review_profile(&last.id, true).unwrap();
    assert_eq!(
        engine.metadata(GLOBAL_MEMORY_KEY, &unedited).unwrap().state,
        "superseded"
    );
    assert!(!engine
        .versions(GLOBAL_MEMORY_KEY, &unedited)
        .unwrap()
        .is_empty());
}
#[test]
fn versions_archive_restore_and_scope_isolation() {
    let (_root, engine) = sandbox();
    let one = "project-one";
    let note = engine
        .save(one, &draft("Old decision"), None, None)
        .unwrap();
    let mut next = draft("New decision");
    next.id = Some(note.id.clone());
    engine.save(one, &next, None, None).unwrap();
    assert_eq!(engine.versions(one, &note.id).unwrap().len(), 2);
    assert!(engine.versions("project-two", &note.id).is_err());
    let mut metadata = engine.metadata(one, &note.id).unwrap();
    metadata.state = "archived".into();
    engine.set_metadata(one, &note.id, &metadata).unwrap();
    assert!(engine.search(one, "decision", 10).unwrap().is_empty());
    assert_eq!(engine.inactive_notes(one).unwrap().len(), 1);
    engine.restore_version(one, &note.id, 1).unwrap();
    assert_eq!(
        engine.get(one, &note.id).unwrap().unwrap().content,
        "Old decision"
    );
    metadata.state = "active".into();
    engine.set_metadata(one, &note.id, &metadata).unwrap();
    assert_eq!(engine.list(one, "").unwrap().len(), 1);
    engine.delete(one, &note.id).unwrap();
    assert!(engine.versions(one, &note.id).is_err());
}
#[test]
fn incremental_export_preserves_local_edits_and_updates_clean_files() {
    let (root, engine) = sandbox();
    let note = engine.save("one", &draft("Decisão ç"), None, None).unwrap();
    let preview = engine.incremental_export("one", &root, false).unwrap();
    assert!(!Path::new(&preview.directory).exists());
    let initial = engine.incremental_export("one", &root, true).unwrap();
    assert!(initial.applied);
    let mut next = draft("Changed");
    next.id = Some(note.id.clone());
    engine.save("one", &next, None, None).unwrap();
    assert!(
        engine
            .incremental_export("one", &root, true)
            .unwrap()
            .applied
    );
    let file = Path::new(&initial.directory).join(format!("memory-{}.md", note.id));
    fs::write(&file, "User edit").unwrap();
    next.content = "Changed again".into();
    engine.save("one", &next, None, None).unwrap();
    let plan = engine.incremental_export("one", &root, true).unwrap();
    assert!(!plan.applied);
    assert_eq!(plan.conflicts.len(), 1);
    assert_eq!(fs::read_to_string(file).unwrap(), "User edit");
}
#[test]
fn structured_events_preserve_files_checks_and_failures() {
    let (_root, engine) = sandbox();
    for (id, kind, summary) in [
        ("1", "prompt", "Fix authentication"),
        ("2", "failure", "cargo test failed: unauthorized"),
        ("3", "verification", "cargo test passed"),
        ("4", "turn-end", "Pending: manual QA"),
    ] {
        engine
            .record_event(
                "one",
                "session",
                "codex",
                &MemoryEvent {
                    id: id.into(),
                    kind: kind.into(),
                    title: kind.into(),
                    summary: summary.into(),
                    files: vec!["src/auth.rs".into()],
                    branch: "main".into(),
                },
            )
            .unwrap();
    }
    let content = &engine.list("one", "").unwrap()[0].content;
    assert!(
        content.contains("src/auth.rs")
            && content.contains("unauthorized")
            && content.contains("cargo test passed")
    );
}

#[test]
fn long_turn_keeps_objective_and_recent_checks_inside_handoff_budget() {
    let (_root, engine) = sandbox();
    engine
        .record_event(
            "one",
            "session",
            "codex",
            &MemoryEvent {
                id: "objective".into(),
                kind: "prompt".into(),
                title: "Prompt".into(),
                summary: "Implement authentication. ".repeat(100),
                files: vec![],
                branch: String::new(),
            },
        )
        .unwrap();
    for number in 0..60 {
        engine
            .record_event(
                "one",
                "session",
                "codex",
                &MemoryEvent {
                    id: format!("tool-{number}"),
                    kind: "tool".into(),
                    title: "Tool".into(),
                    summary: "Observed command".repeat(100),
                    files: vec![format!("src/{}.rs", "long".repeat(50))],
                    branch: String::new(),
                },
            )
            .unwrap();
    }
    for (id, kind, text) in [
        ("failure", "failure", "RECENT_FAILURE"),
        ("check", "verification", "LATEST_VERIFICATION"),
        ("end", "turn-end", "MANUAL_QA_PENDING"),
    ] {
        engine
            .record_event(
                "one",
                "session",
                "codex",
                &MemoryEvent {
                    id: id.into(),
                    kind: kind.into(),
                    title: kind.into(),
                    summary: text.into(),
                    files: vec![],
                    branch: String::new(),
                },
            )
            .unwrap();
    }
    let note = engine.list("one", "").unwrap().remove(0);
    assert!(note.content.len() <= MAX_CAPTURE_BYTES);
    assert!(
        note.content.contains("Objective:")
            && note.content.contains("RECENT_FAILURE")
            && note.content.contains("LATEST_VERIFICATION")
            && note.content.contains("MANUAL_QA_PENDING")
    );
}

#[test]
fn discovery_is_explicit_and_respects_visibility_and_enabled_scopes() {
    let (root, engine) = sandbox();
    let one = engine
        .register_project(root.to_str().unwrap(), None)
        .unwrap();
    let other = root.join("other");
    fs::create_dir(&other).unwrap();
    let two = engine
        .register_project(other.to_str().unwrap(), None)
        .unwrap();
    assert!(!engine.can_discover(&one, &two).unwrap());
    let mut settings = engine.settings(&one).unwrap();
    settings.discovery = true;
    engine.update_project(&one, "One", "", &settings).unwrap();
    assert!(engine.can_discover(&one, &two).unwrap());
    settings = engine.settings(&two).unwrap();
    settings.visible = false;
    engine.update_project(&two, "Two", "", &settings).unwrap();
    assert!(!engine.can_discover(&one, &two).unwrap());
    settings.visible = true;
    engine.update_project(&two, "Two", "", &settings).unwrap();
    engine
        .configure(
            &two,
            &MemoryConfig {
                enabled: false,
                ..MemoryConfig::default()
            },
        )
        .unwrap();
    assert!(!engine.can_discover(&one, &two).unwrap());
}
#[test]
fn deleting_capture_suppresses_replayed_handoffs_and_approved_profile_forgetting() {
    let (_root, engine) = sandbox();
    let note = engine
        .capture(
            "one",
            "s",
            "codex",
            "Task",
            "Enough visible final content to capture this completed work as historical evidence.",
        )
        .unwrap()
        .unwrap();
    engine.delete("one", &note.id).unwrap();
    assert!(engine
        .capture(
            "one",
            "s",
            "codex",
            "Task",
            "Enough visible final content to capture this completed work as historical evidence."
        )
        .unwrap()
        .is_none());
    let event = MemoryEvent {
        id: "pref".into(),
        kind: "prompt".into(),
        title: "Preference".into(),
        summary: "Por padrão prefiro português nas explicações".into(),
        files: vec![],
        branch: String::new(),
    };
    engine.record_event("one", "s", "codex", &event).unwrap();
    let candidate = engine.profile_candidates().unwrap().remove(0);
    let note = engine.review_profile(&candidate.id, true).unwrap().unwrap();
    engine.delete(GLOBAL_MEMORY_KEY, &note.id).unwrap();
    assert_eq!(engine.profile_candidates().unwrap()[0].status, "forgotten");
    assert!(engine.review_profile(&candidate.id, true).is_err());
}
