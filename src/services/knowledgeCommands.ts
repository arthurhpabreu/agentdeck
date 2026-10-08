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

export const knowledgeCommands = {
  config: (projectPath?: string) => invoke<KnowledgeConfig>("get_knowledge_config", { projectPath: projectPath ?? null }),
  health: (projectPath?: string, refresh = false) => invoke<KnowledgeHealth>("get_knowledge_health", { projectPath: projectPath ?? null, refresh }),
  setSource: (sourcePath: string, projectPath?: string) => invoke<KnowledgeConfig>("set_knowledge_source", { sourcePath, projectPath: projectPath ?? null }),
  pickFolder: () => invoke<string>("pick_folder"),
  search: (query: string, projectPath?: string) => invoke<KnowledgeResult[]>("search_knowledge", { query, projectPath: projectPath ?? null }),
  graph: (projectPath?: string, refresh = false) => invoke<KnowledgeGraph>("get_knowledge_graph", { projectPath: projectPath ?? null, refresh }),
  read: (path: string, projectPath?: string) => invoke<KnowledgeResult>("read_knowledge_note", { path, projectPath: projectPath ?? null }),
};
