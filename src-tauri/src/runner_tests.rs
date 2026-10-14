use super::*;

fn fixture(exit_code: Option<u8>) -> Child {
    #[cfg(windows)]
    let mut command = {
        let mut command = background_command("powershell.exe");
        command.args(["-NoProfile", "-NonInteractive", "-Command"]);
        command.arg(exit_code.map_or_else(
            || "Start-Sleep -Seconds 60".into(),
            |code| format!("exit {code}"),
        ));
        command
    };
    #[cfg(unix)]
    let mut command = {
        use std::os::unix::process::CommandExt;
        let mut command = background_command("sh");
        command.process_group(0).args([
            "-c",
            &exit_code.map_or_else(|| "sleep 60".into(), |code| format!("exit {code}")),
        ]);
        command
    };
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

#[test]
fn only_an_actual_successful_exit_confirms_completion() {
    let success = fixture(Some(0)).wait().unwrap();
    let failed = fixture(Some(7)).wait().unwrap();
    let run = uuid::Uuid::new_v4().to_string();
    let payload = done_payload("session", &run, "completed", Some(success), None);
    assert_eq!(payload["status"], "completed");
    assert_eq!(payload["run_id"], run);
    assert_eq!(payload["exit_code"], 0);
    assert_eq!(
        done_payload("session", &run, "completed", Some(failed), None)["status"],
        "error"
    );
    assert_eq!(
        done_payload("session", &run, "completed", None, None)["status"],
        "error"
    );
    assert_eq!(
        done_payload("session", &run, "stopped", Some(success), None)["status"],
        "stopped"
    );
}

#[test]
fn old_worker_cannot_remove_or_poll_a_replacement_child() {
    let map = ProcessMap::default();
    let mut first = fixture(None);
    let first_pid = first.id();
    let replacement = fixture(None);
    let replacement_pid = replacement.id();
    map.lock().unwrap().insert("reused".into(), replacement);
    assert!(take_owned_child(&map, "reused", first_pid).is_none());
    assert!(poll_owned_child(&map, "reused", first_pid).is_err());
    assert_eq!(
        map.lock().unwrap().get("reused").unwrap().id(),
        replacement_pid
    );
    terminate_child(&mut first).unwrap();
    terminate_child(&mut take_owned_child(&map, "reused", replacement_pid).unwrap()).unwrap();
}

#[test]
fn pipe_state_does_not_remove_a_still_running_child_and_stop_releases_the_registry() {
    let map = ProcessMap::default();
    let mut child = fixture(None);
    let pid = child.id();
    drop(child.stdout.take());
    map.lock().unwrap().insert("active".into(), child);
    assert!(poll_owned_child(&map, "active", pid).unwrap().is_none());
    let mut child = take_owned_child(&map, "active", pid).unwrap();
    assert!(map.try_lock().is_ok());
    terminate_child(&mut child).unwrap();
    assert!(child.try_wait().unwrap().is_some());
    assert!(map.lock().unwrap().is_empty());
}

#[test]
fn project_validation_rejects_foreign_roots_and_accepts_the_legacy_default() {
    let base = std::env::temp_dir().join(format!("agentdeck-runner-{}", uuid::Uuid::new_v4()));
    let current = base.join("current");
    let foreign = base.join("foreign");
    std::fs::create_dir_all(&current).unwrap();
    std::fs::create_dir_all(&foreign).unwrap();
    let current_text = current.to_string_lossy();
    let foreign_text = foreign.to_string_lossy();
    assert!(resolve_project(&current_text, None).is_ok());
    assert!(resolve_project(&current_text, Some(&current_text)).is_ok());
    assert!(resolve_project(&current_text, Some(&foreign_text)).is_err());
    assert!(resolve_project(&base.join("missing").to_string_lossy(), None).is_err());
    std::fs::remove_dir_all(base).unwrap();
}

#[test]
fn independent_sessions_have_independent_control_gates() {
    let first = session_gate(&format!("first-{}", uuid::Uuid::new_v4())).unwrap();
    let second = session_gate(&format!("second-{}", uuid::Uuid::new_v4())).unwrap();
    let _held = first.lock().unwrap();
    assert!(second.try_lock().is_ok());
}

#[test]
fn a_verified_linked_worktree_keeps_its_canonical_project_scope() {
    let base = std::env::temp_dir().join(format!(
        "agentdeck-runner-worktree-{}",
        uuid::Uuid::new_v4()
    ));
    let repository = base.join("repository");
    let linked = base.join("linked");
    let metadata = repository.join(".git/worktrees/linked");
    std::fs::create_dir_all(&metadata).unwrap();
    std::fs::create_dir_all(&linked).unwrap();
    std::fs::write(
        linked.join(".git"),
        format!("gitdir: {}\n", metadata.display()),
    )
    .unwrap();
    std::fs::write(
        metadata.join("gitdir"),
        format!("{}\n", linked.join(".git").display()),
    )
    .unwrap();
    std::fs::write(metadata.join("commondir"), "../..\n").unwrap();
    assert!(resolve_project(
        &linked.to_string_lossy(),
        Some(&repository.to_string_lossy())
    )
    .is_ok());
    std::fs::remove_dir_all(base).unwrap();
}

#[cfg(unix)]
#[test]
fn cancellation_kills_owned_descendants_that_ignore_term() {
    use std::os::unix::process::CommandExt;
    let mut command = background_command("sh");
    command
        .process_group(0)
        .args(["-c", "sh -c 'trap \"\" TERM; echo $$; sleep 60' & wait"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = command.spawn().unwrap();
    let mut descendant = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut descendant)
        .unwrap();
    let pid: u32 = descendant.trim().parse().unwrap();
    let live = || {
        let output = background_command("ps")
            .args(["-o", "stat=", "-p", &pid.to_string()])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&output.stdout);
        !state.trim().is_empty() && !state.trim().starts_with('Z')
    };
    assert!(live());
    terminate_child(&mut child).unwrap();
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while live() && std::time::Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !live(),
        "A cancelled runner must not leave its owned tool executing."
    );
}
