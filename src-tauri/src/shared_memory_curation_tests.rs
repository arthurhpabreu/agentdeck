use super::*;
struct Fixture(PathBuf, Option<Engine>);
impl Fixture {
    fn new() -> Self {
        let path =
            std::env::temp_dir().join(format!("agentdeck-curation-{}", uuid::Uuid::new_v4()));
        let engine = Engine::open(&path).unwrap();
        Self(path, Some(engine))
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.1.take();
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn event(engine: &Engine, session: &str, id: &str, kind: &str, summary: &str, files: Vec<String>) {
    engine
        .record_event(
            "project",
            session,
            "codex",
            &MemoryEvent {
                id: id.into(),
                kind: kind.into(),
                title: kind.into(),
                summary: summary.into(),
                files,
                branch: String::new(),
            },
        )
        .unwrap();
}
#[test]
fn automatic_checkpoint_consolidates_followups_and_ignores_chatter() {
    let fixture = Fixture::new();
    let engine = fixture.1.as_ref().unwrap();
    event(
        engine,
        "chat",
        "a",
        "prompt",
        "Implementar autenticação",
        vec![],
    );
    event(
        engine,
        "chat",
        "b",
        "file",
        "Updated",
        vec!["src/auth.rs".into()],
    );
    event(engine, "chat", "c", "turn-end", "Pending", vec![]);
    let initial = engine.list("project", "").unwrap();
    assert_eq!(initial.len(), 1);
    event(
        engine,
        "chat",
        "d",
        "prompt",
        "E adicione testes também",
        vec![],
    );
    event(
        engine,
        "chat",
        "e",
        "verification",
        "cargo test: exit code 0",
        vec![],
    );
    event(engine, "chat", "f", "turn-end", "Pending", vec![]);
    let notes = engine.list("project", "").unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].id, initial[0].id);
    assert!(notes[0].content.contains("Implementar autenticação"));
    assert!(notes[0].content.contains("cargo test"));
    assert!(notes[0].revision > initial[0].revision);
    assert_eq!(notes[0].verification, "auto-selected");
    event(engine, "chat", "g", "prompt", "Obrigado", vec![]);
    event(engine, "chat", "h", "answer", "De nada!", vec![]);
    event(engine, "chat", "i", "turn-end", "Pending", vec![]);
    assert_eq!(
        engine.list("project", "").unwrap()[0].revision,
        notes[0].revision
    );
}
#[test]
fn automatic_cleanup_archives_duplicates_and_preserves_manual_and_pinned_notes() {
    let fixture = Fixture::new();
    let engine = fixture.1.as_ref().unwrap();
    engine.configure_curation("project", false).unwrap();
    for index in 0..4 {
        engine
            .write_record(
                "project",
                &MemoryDraft {
                    id: None,
                    title: format!("Handoff {index}"),
                    content: "Historical context".into(),
                    kind: "handoff".into(),
                    pinned: index == 0,
                },
                Some("old"),
                Some("codex"),
                "capture",
            )
            .unwrap();
    }
    engine
        .save(
            "project",
            &MemoryDraft {
                id: None,
                title: "Manual".into(),
                content: "Important".into(),
                kind: "handoff".into(),
                pinned: false,
            },
            None,
            None,
        )
        .unwrap();
    let status = engine.configure_curation("project", true).unwrap();
    assert_eq!(status.archived, 2);
    assert_eq!(engine.list("project", "").unwrap().len(), 3);
    assert_eq!(engine.inactive_notes("project").unwrap().len(), 2);
    assert_eq!(engine.curate("project").unwrap().archived, 2);
}
#[test]
fn automatic_preferences_require_durable_evidence_and_do_not_replace_user_choices() {
    let fixture = Fixture::new();
    let engine = fixture.1.as_ref().unwrap();
    event(
        engine,
        "chat",
        "a",
        "prompt",
        "Por padrão prefiro pnpm em todos os meus projetos",
        vec![],
    );
    let notes = engine.list(GLOBAL_MEMORY_KEY, "").unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].verification, "auto-selected");
    assert_eq!(notes[0].source, "curation");
    event(
        engine,
        "chat",
        "b",
        "prompt",
        "Por padrão prefiro npm em todos os meus projetos",
        vec![],
    );
    assert_eq!(engine.list(GLOBAL_MEMORY_KEY, "").unwrap().len(), 1);
    engine.configure_curation(GLOBAL_MEMORY_KEY, false).unwrap();
    event(
        engine,
        "chat",
        "c",
        "prompt",
        "Por padrão sempre rode testes antes de encerrar",
        vec![],
    );
    assert_eq!(engine.list(GLOBAL_MEMORY_KEY, "").unwrap().len(), 1);
}

#[test]
fn automatic_preferences_preserve_direct_manual_preferences_and_pending_conflicts() {
    let fixture = Fixture::new();
    let engine = fixture.1.as_ref().unwrap();
    let manual = engine
        .save(
            GLOBAL_MEMORY_KEY,
            &MemoryDraft {
                id: None,
                title: "Package manager".into(),
                content: "Always use yarn for JavaScript projects".into(),
                kind: "fact".into(),
                pinned: true,
            },
            None,
            None,
        )
        .unwrap();
    event(
        engine,
        "chat",
        "a",
        "prompt",
        "Por padrão prefiro pnpm em todos os meus projetos",
        vec![],
    );
    let notes = engine.list(GLOBAL_MEMORY_KEY, "").unwrap();
    assert_eq!(notes.len(), 1);
    assert_eq!(notes[0].id, manual.id);
    assert_eq!(engine.profile_candidates().unwrap()[0].status, "candidate");
    assert_eq!(
        engine
            .metadata(GLOBAL_MEMORY_KEY, &manual.id)
            .unwrap()
            .state,
        "active"
    );
}
