use crate::{
    memory_runtime::{changed, data_dir, open, open_scope},
    shared_memory::*,
};
use serde::Deserialize;
use std::path::Path;

#[derive(Deserialize)]
pub struct ProjectInput {
    pub path: String,
    pub name: String,
}
#[tauri::command]
pub fn memory_catalog(
    app: tauri::AppHandle,
    projects: Vec<ProjectInput>,
    query: Option<String>,
) -> Result<Vec<CatalogProject>, String> {
    if projects.len() > 1000 {
        return Err("Too many projects".into());
    }
    let engine = Engine::open(&data_dir(&app)?)?;
    for project in projects {
        if Path::new(&crate::util::expand_path(&project.path)).is_dir() {
            engine.register_project(
                &crate::util::expand_path(&project.path),
                Some(&project.name),
            )?;
        }
    }
    engine.catalog(query.as_deref().unwrap_or(""))
}
#[tauri::command]
pub fn memory_update_project(
    app: tauri::AppHandle,
    id: String,
    name: String,
    description: String,
    settings: IntelligenceSettings,
) -> Result<(), String> {
    Engine::open(&data_dir(&app)?)?.update_project(&id, &name, &description, &settings)?;
    changed(&app, &id);
    Ok(())
}
#[tauri::command]
pub fn memory_attach_project(
    app: tauri::AppHandle,
    id: String,
    path: String,
) -> Result<(), String> {
    Engine::open(&data_dir(&app)?)?.attach_project_path(&id, &crate::util::expand_path(&path))?;
    changed(&app, &id);
    Ok(())
}
#[tauri::command]
pub fn memory_profile(app: tauri::AppHandle) -> Result<Vec<ProfileCandidate>, String> {
    let engine = Engine::open(&data_dir(&app)?)?;
    engine.curate(GLOBAL_MEMORY_KEY)?;
    engine.profile_candidates()
}
#[tauri::command]
pub fn memory_curation_status(
    app: tauri::AppHandle,
    project_path: String,
    scope: Option<String>,
) -> Result<CurationStatus, String> {
    let (engine, project) = open_scope(&app, &project_path, scope.as_deref())?;
    engine.curate(&project)
}
#[tauri::command]
pub fn memory_set_curation_enabled(
    app: tauri::AppHandle,
    project_path: String,
    scope: Option<String>,
    enabled: bool,
) -> Result<CurationStatus, String> {
    let engine = Engine::open(&data_dir(&app)?)?;
    let project = match scope.as_deref().unwrap_or("project") {
        "project" => engine.register_project(&crate::util::expand_path(&project_path), None)?,
        "global" => GLOBAL_MEMORY_KEY.into(),
        _ => return Err("Invalid memory scope".into()),
    };
    let status = engine.configure_curation(&project, enabled)?;
    changed(&app, &project);
    Ok(status)
}
#[tauri::command]
pub fn memory_review_profile(
    app: tauri::AppHandle,
    id: String,
    accept: bool,
) -> Result<Option<MemoryRecord>, String> {
    let note = Engine::open(&data_dir(&app)?)?.review_profile(&id, accept)?;
    changed(&app, GLOBAL_MEMORY_KEY);
    Ok(note)
}
#[tauri::command]
pub fn memory_metadata(
    app: tauri::AppHandle,
    project_path: String,
    scope: Option<String>,
    id: String,
) -> Result<MemoryMetadata, String> {
    let (engine, project) = open_scope(&app, &project_path, scope.as_deref())?;
    engine.metadata(&project, &id)
}
#[tauri::command]
pub fn memory_set_metadata(
    app: tauri::AppHandle,
    project_path: String,
    scope: Option<String>,
    id: String,
    metadata: MemoryMetadata,
) -> Result<(), String> {
    let (engine, project) = open_scope(&app, &project_path, scope.as_deref())?;
    engine.set_metadata(&project, &id, &metadata)?;
    engine.refresh_catalog_summary(&project)?;
    changed(&app, &project);
    Ok(())
}
#[tauri::command]
pub fn memory_versions(
    app: tauri::AppHandle,
    project_path: String,
    scope: Option<String>,
    id: String,
) -> Result<Vec<MemoryVersion>, String> {
    let (engine, project) = open_scope(&app, &project_path, scope.as_deref())?;
    engine.versions(&project, &id)
}
#[tauri::command]
pub fn memory_restore_version(
    app: tauri::AppHandle,
    project_path: String,
    scope: Option<String>,
    id: String,
    revision: u64,
) -> Result<MemoryRecord, String> {
    let (engine, project) = open_scope(&app, &project_path, scope.as_deref())?;
    let record = engine.restore_version(&project, &id, revision)?;
    changed(&app, &project);
    Ok(record)
}
#[tauri::command]
pub fn memory_inactive(
    app: tauri::AppHandle,
    project_path: String,
    scope: Option<String>,
) -> Result<Vec<MemoryRecord>, String> {
    let (engine, project) = open_scope(&app, &project_path, scope.as_deref())?;
    engine.inactive_notes(&project)
}
#[tauri::command]
pub fn memory_maintain(
    app: tauri::AppHandle,
    project_path: String,
    scope: Option<String>,
    apply: bool,
) -> Result<Vec<MemoryRecord>, String> {
    let (engine, project) = open_scope(&app, &project_path, scope.as_deref())?;
    let records = engine.maintain(&project, apply)?;
    if apply {
        changed(&app, &project);
    }
    Ok(records)
}
#[tauri::command]
pub fn memory_export_incremental(
    app: tauri::AppHandle,
    project_path: String,
    scope: Option<String>,
    destination: String,
    apply: bool,
) -> Result<ExportPlan, String> {
    let (engine, project) = open_scope(&app, &project_path, scope.as_deref())?;
    engine.incremental_export(&project, Path::new(&destination), apply)
}
#[tauri::command]
pub async fn memory_retrieval_preview(
    app: tauri::AppHandle,
    project_path: String,
    query: String,
) -> Result<Vec<crate::memory_retrieval::RetrievalHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (engine, project) = open(&app, &project_path)?;
        crate::memory_retrieval::search(
            &engine,
            &project,
            Some(&project_path),
            Some(&crate::knowledge::app_config(&app)?),
            &query,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
