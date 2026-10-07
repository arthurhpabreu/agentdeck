import { invoke } from "@tauri-apps/api/core";
import { getAgentAdapter } from "./agentAdapters";
import type { RunnerConfig } from "../store/settingsStore";

export interface AgentCommand {
  name: string; description: string; invocation: string; kind: "builtin" | "command" | "skill";
  source: string; transport: "chat" | "native"; path?: string; argumentHint: string;
}
export interface AgentCatalogue { entries: AgentCommand[]; warnings: string[] }
const cache = new Map<string, { at: number; result: AgentCatalogue }>();
const pending = new Map<string, Promise<AgentCatalogue>>();
const keyFor = (runner: RunnerConfig, workdir: string, project: string) => JSON.stringify([runner.type, runner.cliPath ?? "", workdir, project]);
export function fallbackCommands(runner: RunnerConfig): AgentCommand[] {
  const controls = runner.type === "gemini" ? [] : ["/help", "/skills", "/model", "/effort", "/fast", "/plan", "/code", "/status"];
  return [...new Set([...getAgentAdapter(runner.type).commands, ...controls])].map(invocation => ({ name: invocation.slice(1), invocation, description: "", kind: "builtin", source: "builtin", transport: "native", argumentHint: "" }));
}
export async function loadAgentCommands(runner: RunnerConfig, workdir: string, project = workdir, force = false): Promise<AgentCatalogue> {
  const key = keyFor(runner, workdir, project);
  const saved = cache.get(key);
  if (!force && saved && Date.now() - saved.at < 30_000) return saved.result;
  if (pending.has(key)) return pending.get(key)!;
  const request = invoke<AgentCatalogue>("list_agent_commands", { runnerType: runner.type, cliPath: runner.cliPath || null, workdir, projectPath: project, force }).then(value => {
    const result: AgentCatalogue = value && Array.isArray(value.entries) ? value : { entries: fallbackCommands(runner), warnings: ["cli_catalogue_unavailable"] };
    if (cache.size >= 64) cache.delete(cache.keys().next().value!);
    cache.set(key, { at: Date.now(), result });
    return result;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}
export function commandToken(value: string, caret: number) {
  const match = value.slice(0, caret).match(/(?:^|\s)([/\$])([^\s]*)$/);
  if (!match) return undefined;
  return { start: caret - match[1].length - match[2].length, end: caret, prefix: match[1], query: match[2].toLocaleLowerCase() };
}
export function findCommand(prompt: string, catalogue: AgentCatalogue) {
  const name = prompt.trim().split(/\s/, 1)[0];
  return catalogue.entries.find(entry => entry.invocation === name);
}
