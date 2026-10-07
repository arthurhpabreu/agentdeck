import { invoke } from "@tauri-apps/api/core";

export type MemoryKind = "handoff" | "decision" | "fact";
export type MemoryScope = "global" | "project";
export const GLOBAL_MEMORY_KEY = "agentdeck:global";
const scopeArgs = (path: string) => path === GLOBAL_MEMORY_KEY ? { projectPath: "", scope: "global" as const } : { projectPath: path, scope: "project" as const };
export interface MemoryRecord {
  id: string;
  title: string;
  content: string;
  kind: MemoryKind;
  sourceSessionId?: string | null;
  provider?: string | null;
  source?: "manual" | "capture" | "mcp" | "curation";
  verification?: "unverified" | "user-confirmed" | "auto-selected";
  updatedAt: number;
  revision: number;
  pinned: boolean;
  scope?: MemoryScope;
}
export interface MemoryStatus {
  enabled: boolean;
  captureEnabled: boolean;
  budgetTokens: number;
  recordCount: number;
  projectKey: string;
  storage: "local";
  retrieval: "fts5";
  estimatedTokenMethod: "bytes/4";
  scope?: MemoryScope;
  storagePath?: string;
}
export interface MemoryDraft {
  id?: string;
  title: string;
  content: string;
  kind: MemoryKind;
  pinned: boolean;
  sourceSessionId?: string | null;
  provider?: string | null;
}
export type MemoryConfiguration = Pick<MemoryStatus, "enabled" | "captureEnabled" | "budgetTokens">;

export const memoryCommands = {
  status: (projectPath: string) => invoke<MemoryStatus>("memory_status", scopeArgs(projectPath)),
  list: (projectPath: string, query = "") => invoke<MemoryRecord[]>("memory_list", { ...scopeArgs(projectPath), query }),
  save: (projectPath: string, record: MemoryDraft) => invoke<MemoryRecord>("memory_save", { ...scopeArgs(projectPath), record }),
  setPinned: (projectPath: string, id: string, pinned: boolean) => invoke<MemoryRecord>("memory_set_pinned", { ...scopeArgs(projectPath), id, pinned }),
  delete: (projectPath: string, id: string) => invoke<void>("memory_delete", { ...scopeArgs(projectPath), id }),
  configure: (projectPath: string, configuration: MemoryConfiguration) => invoke<MemoryStatus>("memory_configure", { ...scopeArgs(projectPath), ...configuration }),
  openStorage: () => invoke<void>("memory_open_storage"),
  exportMarkdown: (projectPath: string, destination: string) => invoke<{ directory: string; recordCount: number }>("memory_export_markdown", { ...scopeArgs(projectPath), destination }),
  resetSession: (projectPath: string, sessionId: string, provider: string) => invoke<void>("memory_reset_session", { projectPath, sessionId, provider }),
};
