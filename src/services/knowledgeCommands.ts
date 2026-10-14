import { invoke } from "@tauri-apps/api/core";

export interface KnowledgeConfig { sourcePath: string; mode: "none" | "markdown" | "obsidian"; scope: "global" | "project"; projectPath: string | null; storagePath: string }
export interface KnowledgeResult { path: string; title: string; excerpt: string; score: number }
export interface KnowledgeDiagnostics {
  indexedNoteCount: number; indexedBytes: number; noteLimitReached: boolean; indexByteLimitReached: boolean;
  truncatedNoteCount: number; unreadableFileCount: number; unreadableDirectoryCount: number; depthLimitReached: boolean;
  maxNotes: number; maxIndexBytes: number; maxNoteBytes: number; maxDepth: number;
}
export interface KnowledgeWarning { scope: string; sourcePath: string; code: "unavailable" | "index_limited" | "configuration"; message: string; diagnostics?: KnowledgeDiagnostics | null }
export interface KnowledgeHealth { sourcePath: string; status: "none" | "ready" | "limited" | "unavailable"; noteCount: number; checkedAt: number; maxNotes: number; maxIndexBytes: number; maxNoteBytes: number; message: string | null; diagnostics?: KnowledgeDiagnostics | null }
export interface KnowledgeNode { path: string; title: string; links: number }
export interface KnowledgeGraph { nodes: KnowledgeNode[]; edges: { source: string; target: string }[]; noteCount: number; linkCount: number; truncated: boolean; indexLimited: boolean }

export interface KnowledgeVault { id: string; name: string; path: string; mode: "disabled" | "query" | "automatic"; allowedPaths: string[] }
export interface SourceSelection { sourceIds: string[]; personalPreferences: boolean; memoryCollectionIds: string[] }
export interface MemoryCollection { id: string; name: string; recordIds: string[] }
export interface SourcePolicy {
  schemaVersion: number; revision: number; projectKey: string | null; sessionId: string | null;
  inheritProject: boolean; selection: SourceSelection; vaults: KnowledgeVault[]; selectedSources: KnowledgeVault[];
  memoryCollections: MemoryCollection[]; missingSourceIds: string[]; migrationBackup: string | null;
}
export const emptySourceSelection = (): SourceSelection => ({ sourceIds: [], personalPreferences: false, memoryCollectionIds: [] });
export const sourcePolicyCommands = {
  get: (projectPath?: string, sessionId?: string) => invoke<SourcePolicy>("get_source_policy", { projectPath: projectPath ?? null, sessionId: sessionId ?? null }),
  saveVault: (vault: KnowledgeVault) => invoke<KnowledgeVault>("save_knowledge_vault", { vault }),
  removeVault: (sourceId: string) => invoke<void>("remove_knowledge_vault", { sourceId }),
  setProject: (projectPath: string, selection: SourceSelection) => invoke<SourcePolicy>("set_project_source_policy", { projectPath, selection }),
  setConversation: (projectPath: string, sessionId: string, selection: SourceSelection | null) => invoke<SourcePolicy>("set_conversation_source_policy", { projectPath, sessionId, selection }),
  saveCollection: (collection: MemoryCollection) => invoke<MemoryCollection>("save_memory_collection", { collection }),
  rollbackMigration: () => invoke<void>("rollback_source_policy_migration"),
};

export const knowledgeCommands = {
  config: (projectPath?: string) => invoke<KnowledgeConfig>("get_knowledge_config", { projectPath: projectPath ?? null }),
  health: (projectPath?: string, refresh = false, sessionId?: string, sourceId?: string) => invoke<KnowledgeHealth>("get_knowledge_health", { projectPath: projectPath ?? null, refresh, sessionId: sessionId ?? null, sourceId: sourceId ?? null }),
  setSource: (sourcePath: string, projectPath?: string) => invoke<KnowledgeConfig>("set_knowledge_source", { sourcePath, projectPath: projectPath ?? null }),
  pickFolder: () => invoke<string>("pick_folder"),
  search: (query: string, projectPath?: string, sessionId?: string, sourceId?: string) => invoke<KnowledgeResult[]>("search_knowledge", { query, projectPath: projectPath ?? null, sessionId: sessionId ?? null, sourceId: sourceId ?? null }),
  graph: (projectPath?: string, refresh = false, sessionId?: string, sourceId?: string) => invoke<KnowledgeGraph>("get_knowledge_graph", { projectPath: projectPath ?? null, refresh, sessionId: sessionId ?? null, sourceId: sourceId ?? null }),
  read: (path: string, projectPath?: string, sessionId?: string, sourceId?: string) => invoke<KnowledgeResult>("read_knowledge_note", { path, projectPath: projectPath ?? null, sessionId: sessionId ?? null, sourceId: sourceId ?? null }),
};
