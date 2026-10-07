import type { RunnerType, RunnerConfig } from "../store/settingsStore";
import { executionArguments } from "./agentExecution";

export interface AgentAdapter {
  id: RunnerType;
  name: string;
  executable: string;
  installCommand: string;
  supportsResume: boolean;
  models: { id: string; label: string }[];
  commands: string[];
  planArgs: string[];
  createSessionArgs: (resumeSessionId: string) => string[];
}

export const agentAdapters: Record<RunnerType, AgentAdapter> = {
  "claude-code": {
    id: "claude-code", name: "Claude Code", executable: "claude", installCommand: "npm install -g @anthropic-ai/claude-code", supportsResume: true,
    models: [{ id: "sonnet", label: "Sonnet" }, { id: "opus", label: "Opus" }, { id: "haiku", label: "Haiku" }],
    commands: ["/model", "/effort", "/fast", "/resume", "/status", "/context", "/compact", "/permissions", "/help"],
    planArgs: ["--permission-mode", "plan"],
    createSessionArgs: (resumeId) => resumeId ? ["--resume", resumeId] : [],
  },
  codex: {
    id: "codex", name: "OpenAI Codex", executable: "codex", installCommand: "npm install -g @openai/codex", supportsResume: true,
    models: [], commands: ["/model", "/fast", "/resume", "/status", "/compact", "/permissions", "/help"],
    planArgs: ["--sandbox", "read-only"],
    createSessionArgs: (resumeId) => resumeId ? ["resume", resumeId] : [],
  },
  gemini: {
    id: "gemini", name: "Google Gemini", executable: "gemini", installCommand: "npm install -g @google/gemini-cli", supportsResume: true,
    models: [{ id: "gemini-3-pro-preview", label: "Gemini 3 Pro (preview)" }, { id: "gemini-3-flash-preview", label: "Gemini 3 Flash (preview)" }, { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro" }, { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash" }],
    commands: ["/model", "/resume", "/stats", "/memory", "/compress", "/help"],
    planArgs: ["--approval-mode", "plan"],
    createSessionArgs: (resumeId) => resumeId ? ["--resume", resumeId] : [],
  },
};

export function getAgentAdapter(id: RunnerType) { return agentAdapters[id]; }
export function createAgentSessionArgs(id: RunnerType, resumeSessionId = "", model = "", mode: "default" | "plan" = "default", runner?: RunnerConfig, workdir = "") {
  const adapter = getAgentAdapter(id);
  return [...adapter.createSessionArgs(resumeSessionId), ...(model.trim() && model !== "default" ? ["--model", model.trim()] : []), ...(mode === "plan" ? adapter.planArgs : []), ...executionArguments(runner ? { ...runner, mode } : { type: id, model, mode }, workdir)];
}
export function supportsAgentResume(id: RunnerType) {
  return getAgentAdapter(id).supportsResume;
}
