//! Local command/skill discovery. Metadata probes never submit a model turn.
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, HashMap},
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::Stdio,
    sync::{mpsc, Mutex, OnceLock},
    time::{Duration, Instant},
};

const MAX_ENTRIES: usize = 1500;
const MAX_FILE: u64 = 256 * 1024;

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCommand {
    pub name: String,
    pub description: String,
    pub invocation: String,
    pub kind: String,
    pub source: String,
    pub transport: String,
    pub path: Option<String>,
    pub argument_hint: String,
}
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentCatalogue {
    pub entries: Vec<AgentCommand>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Deserialize, Serialize)]
pub struct SkillReference {
    pub name: String,
    pub path: String,
}

type Cache = HashMap<String, (Instant, AgentCatalogue)>;
static CACHE: OnceLock<Mutex<Cache>> = OnceLock::new();

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 160
        && !name.starts_with('-')
        && name
            .chars()
            .all(|c| c.is_alphanumeric() || "-_:./".contains(c))
        && !name.contains("..")
}
fn text(value: &str, max: usize) -> String {
    value
        .chars()
        .filter(|c| !c.is_control() || *c == '\n')
        .take(max)
        .collect()
}
fn read_file(path: &Path) -> Option<String> {
    if fs::metadata(path).ok()?.len() > MAX_FILE {
        return None;
    }
    fs::read_to_string(path).ok()
}
fn read_json(path: &Path) -> Value {
    read_file(path)
        .and_then(|v| serde_json::from_str(&v).ok())
        .unwrap_or(Value::Null)
}

// Read display metadata only; never execute skill instructions or command bodies.
fn frontmatter(content: &str, key: &str) -> Option<String> {
    let mut lines = content.trim_start_matches('\u{feff}').lines();
    if lines.next()?.trim() != "---" {
        return None;
    }
    let lines: Vec<_> = lines.take_while(|line| line.trim() != "---").collect();
    for (index, line) in lines.iter().enumerate() {
        if let Some(value) = line.strip_prefix(&format!("{key}:")) {
            let value = value.trim();
            if matches!(value, ">" | "|" | ">-" | "|-") {
                return Some(
                    lines[index + 1..]
                        .iter()
                        .take_while(|line| line.starts_with([' ', '\t']))
                        .map(|line| line.trim())
                        .collect::<Vec<_>>()
                        .join(" "),
                );
            }
            return Some(value.trim_matches(['"', '\'']).to_owned());
        }
    }
    None
}
fn file_entry(
    path: &Path,
    root: &Path,
    provider: &str,
    kind: &str,
    source: &str,
    namespace: Option<&str>,
) -> Option<AgentCommand> {
    let content = read_file(path)?;
    if frontmatter(&content, "user-invocable").as_deref() == Some("false") {
        return None;
    }
    let relative = path.strip_prefix(root).ok()?;
    let fallback = if kind == "skill" {
        path.parent()?.file_name()?.to_string_lossy().into_owned()
    } else {
        relative
            .with_extension("")
            .components()
            .map(|part| part.as_os_str().to_string_lossy())
            .collect::<Vec<_>>()
            .join(":")
    };
    let base = frontmatter(&content, "name").unwrap_or(fallback);
    let name = namespace.map(|ns| format!("{ns}:{base}")).unwrap_or(base);
    if !valid_name(&name) {
        return None;
    }
    let (description, argument_hint) = if provider == "gemini" && kind == "command" {
        let value = toml::from_str::<toml::Value>(&content).ok()?;
        (
            value
                .get("description")
                .and_then(toml::Value::as_str)
                .unwrap_or("")
                .to_owned(),
            String::new(),
        )
    } else {
        (
            frontmatter(&content, "description")
                .or_else(|| frontmatter(&content, "when_to_use"))
                .unwrap_or_default(),
            frontmatter(&content, "argument-hint").unwrap_or_default(),
        )
    };
    let invocation = match (provider, kind) {
        ("codex", "skill") => format!("${name}"),
        ("codex", _) => format!("/prompts:{name}"),
        ("gemini", "skill") => format!("Use the {name} skill:"),
        _ => format!("/{name}"),
    };
    Some(AgentCommand {
        name,
        description: text(&description, 800),
        invocation,
        kind: kind.into(),
        source: source.into(),
        transport: if provider == "codex" && kind != "skill" {
            "native"
        } else {
            "chat"
        }
        .into(),
        path: Some(fs::canonicalize(path).ok()?.to_string_lossy().into_owned()),
        argument_hint: text(&argument_hint, 160),
    })
}
fn scan(
    root: &Path,
    provider: &str,
    kind: &str,
    source: &str,
    namespace: Option<&str>,
    entries: &mut BTreeMap<String, AgentCommand>,
) {
    let mut stack = vec![(root.to_path_buf(), 0)];
    let mut visited = std::collections::HashSet::new();
    let mut inspected = 0;
    while let Some((directory, depth)) = stack.pop() {
        if depth > 10 || inspected > 6000 || entries.len() >= MAX_ENTRIES {
            break;
        }
        let Ok(canonical) = fs::canonicalize(&directory) else {
            continue;
        };
        if !visited.insert(canonical) {
            continue;
        }
        let Ok(children) = fs::read_dir(&directory) else {
            continue;
        };
        let mut children: Vec<_> = children.flatten().collect();
        children.sort_by_key(|child| child.file_name());
        for child in children {
            inspected += 1;
            let path = child.path();
            let name = child.file_name().to_string_lossy().into_owned();
            if path.is_dir() {
                if matches!(name.as_str(), "node_modules" | "target" | ".git" | ".trash") {
                    continue;
                }
                stack.push((path, depth + 1));
            } else if (kind == "skill" && name == "SKILL.md")
                || (kind == "command"
                    && path.extension().is_some_and(|extension| {
                        extension == if provider == "gemini" { "toml" } else { "md" }
                    }))
            {
                if let Some(entry) = file_entry(&path, root, provider, kind, source, namespace) {
                    entries.insert(entry.invocation.clone(), entry);
                }
            }
        }
    }
}
fn builtins(provider: &str) -> Vec<AgentCommand> {
    let commands: &[(&str, &str)] = match provider {
        "claude-code" => &[
            ("help", "Browse commands and skills"),
            ("skills", "Browse installed skills"),
            ("model", "Choose the model"),
            ("effort", "Choose reasoning effort"),
            ("fast", "Configure fast mode"),
            ("plan", "Switch to read-only planning"),
            ("code", "Switch to code mode"),
            ("status", "Inspect the current session"),
            ("compact", "Compact native conversation history"),
            ("context", "Inspect provider context"),
            ("permissions", "Manage native permissions"),
            ("resume", "Resume a native conversation"),
        ],
        "codex" => &[
            ("help", "Browse commands and skills"),
            ("skills", "Browse installed skills"),
            ("model", "Choose the model"),
            ("effort", "Choose reasoning effort"),
            ("fast", "Configure fast mode"),
            ("plan", "Switch to read-only planning"),
            ("code", "Switch to code mode"),
            ("status", "Inspect the current session"),
            ("compact", "Compact history in the native terminal"),
            ("permissions", "Manage native permissions"),
            ("resume", "Resume a native conversation"),
            ("review", "Review changes in the native terminal"),
        ],
        _ => &[
            ("help", "Show native CLI help"),
            ("skills", "Manage installed skills"),
            ("model", "Choose the model"),
            ("stats", "Show session statistics"),
            ("memory", "Manage project context"),
            ("compress", "Compress native conversation history"),
            ("resume", "Resume a conversation"),
            ("extensions", "Manage extensions"),
            ("settings", "Configure the CLI"),
        ],
    };
    commands
        .iter()
        .map(|(name, description)| AgentCommand {
            name: (*name).into(),
            description: (*description).into(),
            invocation: format!("/{name}"),
            kind: "builtin".into(),
            source: "builtin".into(),
            transport: "native".into(),
            path: None,
            argument_hint: String::new(),
        })
        .collect()
}

fn project_roots(workdir: &Path, project: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    // Stop at the selected project/worktree or repository boundary; don't scan unrelated ancestors.
    let mut current = workdir.to_path_buf();
    for _ in 0..32 {
        roots.push(current.clone());
        if current == project || current.join(".git").exists() {
            break;
        }
        if !current.pop() || !current.starts_with(project) {
            break;
        }
    }
    roots.reverse();
    if !roots.iter().any(|root| root == project) {
        roots.insert(0, project.to_path_buf());
    }
    roots
}
fn scan_provider(
    root: &Path,
    provider: &str,
    source: &str,
    entries: &mut BTreeMap<String, AgentCommand>,
) {
    let folder = match provider {
        "claude-code" => ".claude",
        "codex" => ".codex",
        _ => ".gemini",
    };
    scan(
        &root.join(folder).join("skills"),
        provider,
        "skill",
        source,
        None,
        entries,
    );
    if provider != "claude-code" {
        scan(
            &root.join(".agents/skills"),
            provider,
            "skill",
            source,
            None,
            entries,
        );
    }
    scan(
        &root.join(folder).join(if provider == "codex" {
            "prompts"
        } else {
            "commands"
        }),
        provider,
        "command",
        source,
        None,
        entries,
    );
}
fn claude_plugins(
    home: &Path,
    projects: &[PathBuf],
    entries: &mut BTreeMap<String, AgentCommand>,
) -> BTreeMap<String, String> {
    let mut enabled = BTreeMap::new();
    let mut overrides = BTreeMap::new();
    for file in std::iter::once(home.join(".claude/settings.json")).chain(projects.iter().flat_map(
        |root| {
            [
                root.join(".claude/settings.json"),
                root.join(".claude/settings.local.json"),
            ]
        },
    )) {
        let settings = read_json(&file);
        if let Some(plugins) = settings["enabledPlugins"].as_object() {
            for (name, state) in plugins {
                enabled.insert(name.clone(), state == true);
            }
        }
        if let Some(values) = settings["skillOverrides"].as_object() {
            for (name, value) in values {
                overrides.insert(name.clone(), value.as_str().unwrap_or("").to_owned());
            }
        }
    }
    let installed = read_json(&home.join(".claude/plugins/installed_plugins.json"));
    if let Some(plugins) = installed["plugins"].as_object() {
        for (id, versions) in plugins {
            if enabled.get(id) != Some(&true) {
                continue;
            }
            let namespace = id.split('@').next().unwrap_or(id);
            for version in versions.as_array().into_iter().flatten() {
                if version["scope"] == "project" || version["scope"] == "local" {
                    let Some(path) = version["projectPath"].as_str() else {
                        continue;
                    };
                    if !projects.iter().any(|root| root == Path::new(path)) {
                        continue;
                    }
                }
                if let Some(path) = version["installPath"].as_str() {
                    scan(
                        &Path::new(path).join("skills"),
                        "claude-code",
                        "skill",
                        "plugin",
                        Some(namespace),
                        entries,
                    );
                    scan(
                        &Path::new(path).join("commands"),
                        "claude-code",
                        "command",
                        "plugin",
                        Some(namespace),
                        entries,
                    );
                }
            }
        }
    }
    overrides
}

fn gemini_extension_enabled(config: &Value, name: &str, workdir: &Path) -> bool {
    let normalized = format!(
        "/{}/",
        workdir
            .to_string_lossy()
            .replace('\\', "/")
            .trim_matches('/')
    );
    let mut enabled = true;
    for rule in config[name]["overrides"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
    {
        let pattern = rule.trim_start_matches('!').replace('\\', "/");
        let pattern = if pattern.ends_with('*') {
            pattern
        } else {
            format!("{}/", pattern.trim_end_matches('/'))
        };
        let pattern = format!("/{}", pattern.trim_start_matches('/'));
        let expression = format!(
            "^{}$",
            pattern
                .split('*')
                .map(regex::escape)
                .collect::<Vec<_>>()
                .join(".*")
        );
        if regex::Regex::new(&expression).is_ok_and(|re| re.is_match(&normalized)) {
            enabled = !rule.starts_with('!');
        }
    }
    enabled
}

fn gemini_extensions(home: &Path, workdir: &Path, entries: &mut BTreeMap<String, AgentCommand>) {
    let root = home.join(".gemini/extensions");
    let enablement = read_json(&root.join("extension-enablement.json"));
    let Ok(children) = fs::read_dir(&root) else {
        return;
    };
    let mut children: Vec<_> = children.flatten().collect();
    children.sort_by_key(|child| child.file_name());
    for child in children.into_iter().take(512) {
        let path = child.path();
        if !path.is_dir() {
            continue;
        }
        let manifest = read_json(&path.join("gemini-extension.json"));
        let Some(name) = manifest["name"].as_str() else {
            continue;
        };
        if !gemini_extension_enabled(&enablement, name, workdir) {
            continue;
        }
        scan(
            &path.join("skills"),
            "gemini",
            "skill",
            "plugin",
            None,
            entries,
        );
        scan(
            &path.join("commands"),
            "gemini",
            "command",
            "plugin",
            None,
            entries,
        );
    }
}

// Initialization-only native metadata; read bounded stdout and kill the whole probe tree on timeout.
fn native_metadata(provider: &str, cli_path: &str, workdir: &Path) -> Result<Value, String> {
    let executable = crate::util::find_cli_path(provider, cli_path);
    let args: Vec<String> = if provider == "codex" {
        vec!["app-server".into(), "--listen".into(), "stdio://".into()]
    } else {
        [
            "--safe-mode",
            "--print",
            "--verbose",
            "--input-format",
            "stream-json",
            "--output-format",
            "stream-json",
            "--no-session-persistence",
        ]
        .map(str::to_owned)
        .to_vec()
    };
    let (executable, args) = crate::util::resolve_windows_pty_command(&executable, &args);
    let mut child = crate::util::background_command(&executable)
        .args(args)
        .current_dir(workdir)
        .env("DISABLE_AUTOUPDATER", "1")
        .env("CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "1")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| "cli_catalogue_unavailable")?;
    let output = child.stdout.take().ok_or("cli_catalogue_unavailable")?;
    let (sender, receiver) = mpsc::channel();
    let reader = std::thread::spawn(move || {
        for line in BufReader::new(output.take(4 * 1024 * 1024))
            .lines()
            .map_while(Result::ok)
        {
            if let Ok(value) = serde_json::from_str::<Value>(&line) {
                if sender.send(value).is_err() {
                    break;
                }
            }
        }
    });
    let result = (|| {
        let input = child.stdin.as_mut().ok_or("cli_catalogue_unavailable")?;
        let request = if provider == "codex" {
            json!({"id":1,"method":"initialize","params":{"clientInfo":{"name":"agentdeck","version":env!("CARGO_PKG_VERSION")}}})
        } else {
            json!({"type":"control_request","request_id":"agentdeck-commands","request":{"subtype":"initialize","hooks":{},"sdkMcpServers":[]}})
        };
        writeln!(input, "{request}").map_err(|_| "cli_catalogue_unavailable")?;
        let deadline = Instant::now() + Duration::from_secs(12);
        loop {
            let value = receiver
                .recv_timeout(deadline.saturating_duration_since(Instant::now()))
                .map_err(|_| "cli_catalogue_unavailable")?;
            if provider != "codex" {
                if value["type"] == "control_response"
                    && value["response"]["request_id"] == "agentdeck-commands"
                {
                    return Ok(value["response"]["response"].clone());
                }
            } else if value["id"] == 1 {
                if value.get("error").is_some() {
                    return Err("cli_catalogue_unavailable");
                }
                writeln!(input, "{}", json!({"method":"initialized"}))
                    .map_err(|_| "cli_catalogue_unavailable")?;
                writeln!(input, "{}", json!({"id":2,"method":"skills/list","params":{"cwds":[workdir],"forceReload":true}})).map_err(|_| "cli_catalogue_unavailable")?;
            } else if value["id"] == 2 {
                if value["result"]["data"].is_array() {
                    return Ok(value["result"].clone());
                }
                return Err("cli_catalogue_unavailable");
            }
        }
    })();
    drop(child.stdin.take());
    crate::cli_updates::terminate_probe(&mut child);
    let _ = reader.join();
    result.map_err(str::to_owned)
}
fn native_entries(provider: &str, value: &Value, entries: &mut BTreeMap<String, AgentCommand>) {
    if provider == "codex" {
        // Native scope/enablement is authoritative, including installed plugins.
        entries.retain(|_, entry| entry.kind != "skill");
        for skill in value["data"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|group| group["skills"].as_array().into_iter().flatten())
        {
            let (Some(name), Some(path)) = (skill["name"].as_str(), skill["path"].as_str()) else {
                continue;
            };
            if skill["enabled"] == false || !valid_name(name) {
                continue;
            }
            let entry = AgentCommand {
                name: name.into(),
                description: text(
                    skill["interface"]["shortDescription"]
                        .as_str()
                        .or_else(|| skill["description"].as_str())
                        .unwrap_or(""),
                    800,
                ),
                invocation: format!("${name}"),
                kind: "skill".into(),
                source: skill["scope"].as_str().unwrap_or("native").to_lowercase(),
                transport: "chat".into(),
                path: Some(path.into()),
                argument_hint: String::new(),
            };
            entries.insert(entry.invocation.clone(), entry);
        }
    } else {
        for command in value["commands"].as_array().into_iter().flatten() {
            let Some(name) = command["name"].as_str() else {
                continue;
            };
            if !valid_name(name) || name.starts_with('_') {
                continue;
            }
            let invocation = format!("/{name}");
            if entries.contains_key(&invocation) && entries[&invocation].kind != "builtin" {
                continue;
            }
            entries.insert(
                invocation.clone(),
                AgentCommand {
                    name: name.into(),
                    invocation,
                    description: text(command["description"].as_str().unwrap_or(""), 800),
                    kind: "builtin".into(),
                    source: "native".into(),
                    transport: "chat".into(),
                    path: None,
                    argument_hint: text(command["argumentHint"].as_str().unwrap_or(""), 160),
                },
            );
        }
    }
}
pub fn catalogue(
    provider: &str,
    cli_path: &str,
    workdir: &str,
    project: &str,
    force: bool,
) -> Result<AgentCatalogue, String> {
    if !matches!(provider, "codex" | "claude-code" | "gemini") {
        return Err("Unsupported provider".into());
    }
    let key = format!("{provider}\0{cli_path}\0{workdir}\0{project}");
    let cache = CACHE.get_or_init(Default::default);
    if !force {
        if let Some((at, result)) = cache.lock().map_err(|_| "Catalogue unavailable")?.get(&key) {
            if at.elapsed() < Duration::from_secs(30) {
                return Ok(result.clone());
            }
        }
    }
    let home = PathBuf::from(
        std::env::var("USERPROFILE")
            .or_else(|_| std::env::var("HOME"))
            .unwrap_or_default(),
    );
    let workdir = PathBuf::from(crate::util::expand_path(workdir));
    let project = PathBuf::from(crate::util::expand_path(if project.is_empty() {
        workdir.to_str().unwrap_or("")
    } else {
        project
    }));
    let roots = project_roots(&workdir, &project);
    let mut entries: BTreeMap<_, _> = builtins(provider)
        .into_iter()
        .map(|entry| (entry.invocation.clone(), entry))
        .collect();
    if provider == "gemini" {
        gemini_extensions(&home, &workdir, &mut entries);
    }
    if provider != "claude-code" {
        scan_provider(&home, provider, "user", &mut entries);
    }
    for root in &roots {
        scan_provider(root, provider, "project", &mut entries);
    }
    let overrides = if provider == "claude-code" {
        let overrides = claude_plugins(&home, &roots, &mut entries);
        scan_provider(&home, provider, "user", &mut entries);
        overrides
    } else {
        BTreeMap::new()
    };
    if provider == "codex" {
        if let Some(root) = std::env::var_os("CODEX_HOME") {
            scan(
                &PathBuf::from(root).join("skills"),
                provider,
                "skill",
                "user",
                None,
                &mut entries,
            );
        }
    }
    if provider == "gemini" {
        let mut settings = read_json(&home.join(".gemini/settings.json"));
        for root in &roots {
            let local = read_json(&root.join(".gemini/settings.json"));
            if local["skills"].is_object() {
                settings["skills"] = local["skills"].clone();
            }
        }
        let disabled = settings["skills"]["disabled"].as_array();
        entries.retain(|_, entry| {
            if entry.kind == "skill" && settings["skills"]["enabled"] == false {
                return false;
            }
            !disabled.is_some_and(|values| {
                values
                    .iter()
                    .any(|value| value.as_str() == Some(&entry.name))
            })
        });
    }
    let mut warnings = Vec::new();
    if provider != "gemini" {
        match native_metadata(provider, cli_path, &workdir) {
            Ok(value) => native_entries(provider, &value, &mut entries),
            Err(error) => warnings.push(error),
        }
    }
    entries.retain(|_, entry| {
        overrides
            .get(&entry.name)
            .is_none_or(|state| state != "off")
    });
    if entries.len() >= MAX_ENTRIES {
        warnings.push("catalogue_limit".into());
    }
    let result = AgentCatalogue {
        entries: entries.into_values().take(MAX_ENTRIES).collect(),
        warnings,
    };
    let mut cache = cache.lock().map_err(|_| "Catalogue unavailable")?;
    if cache.len() > 64 {
        cache.clear();
    }
    cache.insert(key, (Instant::now(), result.clone()));
    Ok(result)
}
pub fn resolve_codex_skills(
    prompt: &str,
    cli_path: &str,
    workdir: &str,
    project: &str,
) -> Result<Vec<SkillReference>, String> {
    let names: Vec<_> = regex::Regex::new(r"(?:^|\s)\$([\p{L}\p{N}_:./-]+)")
        .unwrap()
        .captures_iter(prompt)
        .map(|capture| capture[1].to_owned())
        .collect();
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let catalog = catalogue("codex", cli_path, workdir, project, false)?;
    let mut result = Vec::new();
    for name in names {
        if result
            .iter()
            .any(|skill: &SkillReference| skill.name == name)
        {
            continue;
        }
        if let Some(entry) = catalog
            .entries
            .iter()
            .find(|entry| entry.kind == "skill" && entry.name == name)
        {
            let Some(path) = &entry.path else {
                continue;
            };
            if !Path::new(path).is_file() {
                return Err(format!(
                    "Skill {name} no longer exists. Refresh the catalogue."
                ));
            }
            result.push(SkillReference {
                name,
                path: path.clone(),
            });
        }
    }
    Ok(result)
}
#[tauri::command]
pub async fn list_agent_commands(
    runner_type: String,
    cli_path: Option<String>,
    workdir: String,
    project_path: Option<String>,
    force: Option<bool>,
) -> Result<AgentCatalogue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        catalogue(
            &runner_type,
            cli_path.as_deref().unwrap_or(""),
            &workdir,
            project_path.as_deref().unwrap_or(&workdir),
            force.unwrap_or(false),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn gemini_extension_rules_apply_in_order_and_match_workspace_paths() {
        let config =
            json!({"review":{"overrides":["!/*", "/C:/Projects/*", "!/C:/Projects/Private/*"]}});
        assert!(!gemini_extension_enabled(
            &config,
            "review",
            Path::new("C:/Elsewhere")
        ));
        assert!(gemini_extension_enabled(
            &config,
            "review",
            Path::new("C:/Projects/Public")
        ));
        assert!(!gemini_extension_enabled(
            &config,
            "review",
            Path::new("C:/Projects/Private/Work")
        ));
        assert!(gemini_extension_enabled(
            &config,
            "other",
            Path::new("C:/Elsewhere")
        ));
    }

    #[test]
    #[ignore = "Opt-in installed CLI initialization probes; no model prompts"]
    fn installed_command_catalogues_smoke() {
        let workdir = std::env::current_dir().unwrap();
        for provider in ["claude-code", "codex"] {
            let value = native_metadata(provider, "", &workdir).unwrap();
            let mut entries = BTreeMap::new();
            native_entries(provider, &value, &mut entries);
            assert!(!entries.is_empty(), "Empty metadata for {provider}");
            println!(
                "{provider}: {} entries discovered without inference",
                entries.len()
            );
        }
    }
    #[test]
    fn metadata_preserves_multiline_descriptions_and_user_only_skills() {
        assert_eq!(frontmatter("---\nname: 'review'\ndescription: >-\n  Review changes\n  and tests\ndisable-model-invocation: true\n---\nBody", "description").as_deref(), Some("Review changes and tests"));
        assert_eq!(
            frontmatter("---\nuser-invocable: false\n---", "user-invocable").as_deref(),
            Some("false")
        );
        assert!(!valid_name("name\n--unsafe"));
        assert!(valid_name("plugin:review"));
    }
    #[test]
    fn native_skills_override_fallback_and_respect_disabled_state() {
        let mut entries: BTreeMap<_, _> = builtins("codex")
            .into_iter()
            .map(|entry| (entry.invocation.clone(), entry))
            .collect();
        native_entries(
            "codex",
            &json!({"data":[{"skills":[{"name":"review","path":"/skills/review/SKILL.md","enabled":true,"scope":"PROJECT","description":"Review"},{"name":"hidden","path":"/skills/hidden/SKILL.md","enabled":false}]}]}),
            &mut entries,
        );
        assert!(entries.contains_key("$review"));
        assert!(!entries.contains_key("$hidden"));
        assert_eq!(entries["$review"].source, "project");
        assert_eq!(entries["$review"].transport, "chat");
    }
    #[test]
    fn file_catalogue_handles_nested_commands_overrides_and_hidden_skills() {
        let root =
            std::env::temp_dir().join(format!("agentdeck-catalogue-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join(".claude/commands/security")).unwrap();
        fs::create_dir_all(root.join(".claude/skills/private")).unwrap();
        fs::write(root.join(".claude/commands/security/review.md"), "---\ndescription: Review security\nargument-hint: [path]\n---\nDo not run during discovery.").unwrap();
        fs::write(
            root.join(".claude/skills/private/SKILL.md"),
            "---\nname: private\nuser-invocable: false\n---\nHidden",
        )
        .unwrap();
        let mut entries = BTreeMap::new();
        scan_provider(&root, "claude-code", "project", &mut entries);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries["/security:review"].argument_hint, "[path]");
        assert_eq!(entries["/security:review"].description, "Review security");
        fs::remove_dir_all(&root).unwrap();
    }
}
