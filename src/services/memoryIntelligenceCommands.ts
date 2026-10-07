import { invoke } from "@tauri-apps/api/core";
import { GLOBAL_MEMORY_KEY, type MemoryRecord } from "./memoryCommands";
const scopeArgs = (path: string) => path === GLOBAL_MEMORY_KEY ? { projectPath: "", scope: "global" } : { projectPath: path, scope: "project" };
export interface IntelligenceSettings { contribute: boolean; consume: boolean; discovery: boolean; visible: boolean }
export interface CatalogProject { id: string; name: string; description: string; stack: string[]; paths: string[]; repositoryIdentity: string; updatedAt: number; recordCount: number; settings: IntelligenceSettings }
export interface ProfileCandidate { id: string; topic: string; statement: string; category: string; appliesTo: string[]; general: boolean; status: string; recordId: string | null; projectCount: number; eligible: boolean; evidence: { projectKey: string; eventId: string; quote: string; observedAt: number }[] }
export interface MemoryMetadata { category: string; appliesTo: string[]; state: string; supersededBy: string | null; relations: Record<string, string[]>; accessCount: number; lastAccessedAt: number; feedback: string }
export interface MemoryVersion { record: MemoryRecord; recordedAt: number }
export interface ExportPlan { directory: string; changes: { path: string; action: string }[]; conflicts: string[]; recordCount: number; applied: boolean }
export interface RetrievalHit { id: string; source: string; scope: string; title: string; excerpt: string; revision: number; score: number; reason: string; path: string | null }
export const intelligenceCommands = {
  catalog: (projects: { path: string; name: string }[], query = "") => invoke<CatalogProject[]>("memory_catalog", { projects, query }),
  updateProject: (project: CatalogProject) => invoke<void>("memory_update_project", { id: project.id, name: project.name, description: project.description, settings: project.settings }),
  attachProject: (id: string, path: string) => invoke<void>("memory_attach_project", { id, path }),
  profile: () => invoke<ProfileCandidate[]>("memory_profile"),
  review: (id: string, accept: boolean) => invoke<MemoryRecord | null>("memory_review_profile", { id, accept }),
  metadata: (path: string, id: string) => invoke<MemoryMetadata>("memory_metadata", { ...scopeArgs(path), id }),
  setMetadata: (path: string, id: string, metadata: MemoryMetadata) => invoke<void>("memory_set_metadata", { ...scopeArgs(path), id, metadata }),
  versions: (path: string, id: string) => invoke<MemoryVersion[]>("memory_versions", { ...scopeArgs(path), id }),
  restoreVersion: (path: string, id: string, revision: number) => invoke<MemoryRecord>("memory_restore_version", { ...scopeArgs(path), id, revision }),
  inactive: (path: string) => invoke<MemoryRecord[]>("memory_inactive", scopeArgs(path)),
  maintain: (path: string, apply: boolean) => invoke<MemoryRecord[]>("memory_maintain", { ...scopeArgs(path), apply }),
  export: (path: string, destination: string, apply: boolean) => invoke<ExportPlan>("memory_export_incremental", { ...scopeArgs(path), destination, apply }),
  search: (projectPath: string, query: string) => invoke<RetrievalHit[]>("memory_retrieval_preview", { projectPath, query }),
};
