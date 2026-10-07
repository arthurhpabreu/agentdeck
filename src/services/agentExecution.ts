import { invoke } from "@tauri-apps/api/core";
import { normalizeEffort, type RunnerConfig, type ReasoningEffort } from "../store/settingsStore";

export interface AgentModel {
  id: string;
  label: string;
  reasoningEfforts?: string[];
  fastMode?: boolean;
  resolvedModel?: string;
  cliVersion?: string;
}

const catalogues = new Map<string, AgentModel[]>();
const pending = new Map<string, Promise<AgentModel[]>>();
const catalogueKey = (provider: string, cliPath = "", workdir = "") => JSON.stringify([provider, cliPath, provider === "codex" ? workdir : ""]);
export function clearAgentModels(provider: string) { for (const key of catalogues.keys()) if (JSON.parse(key)[0] === provider) catalogues.delete(key); }
export function cachedAgentModels(provider: string, cliPath = "", workdir = "") { return catalogues.get(catalogueKey(provider, cliPath, workdir)); }
export function loadAgentModels(provider: string, cliPath = "", force = false, workdir = ""): Promise<AgentModel[]> {
  const key = catalogueKey(provider, cliPath, workdir);
  if (pending.has(key)) return pending.get(key)!;
  if (!force && catalogues.has(key)) return Promise.resolve(catalogues.get(key)!);
  const request = invoke<AgentModel[]>("list_agent_models", { runnerType: provider, cliPath: cliPath || null, workdir: workdir || null }).then(items => {
    const models = Array.isArray(items) ? items : [];
    catalogues.set(key, models);
    return models;
  }).finally(() => pending.delete(key));
  pending.set(key, request);
  return request;
}

export function executionCapabilities(runner: RunnerConfig, workdir = "") {
  const entry = cachedAgentModels(runner.type, runner.cliPath, workdir)?.find(item => item.id === (runner.model || "default") || !!runner.model && item.resolvedModel === runner.model);
  const model = (entry?.resolvedModel || runner.model)?.toLowerCase() || "";
  if (runner.type === "claude-code") {
    const supported = !model || /opus|sonnet|fable/.test(model);
    const older = /4[.-]6/.test(model);
    const levels = entry?.reasoningEfforts ?? (supported ? ["low", "medium", "high"] : []);
    const version = entry?.cliVersion?.split(".").map(Number);
    const independentUltra = !!version && (version[0] > 2 || version[0] === 2 && (version[1] > 1 || version[1] === 1 && version[2] >= 284));
    return { efforts: levels as ReasoningEffort[], ultra: levels.includes("xhigh") && independentUltra && !older, fast: entry?.fastMode === true, known: !!entry };
  }
  const levels = entry?.reasoningEfforts;
  return {
    efforts: (levels ? levels.filter(level => ["none", "minimal", "low", "medium", "high", "xhigh", "max"].includes(level)) : ["low", "medium", "high"]) as ReasoningEffort[],
    ultra: levels?.includes("ultra") === true,
    fast: entry?.fastMode === true,
    known: !!levels,
  };
}

export function modelDisplayName(runner: RunnerConfig, workdir = ""): string {
  const entry = cachedAgentModels(runner.type, runner.cliPath, workdir)?.find(item => item.id === (runner.model || "default") || !!runner.model && item.resolvedModel === runner.model);
  return entry?.id === "default" ? entry.resolvedModel || entry.label : entry?.label || runner.model || "";
}

/** Always send explicit choices so a global CLI 'ultra'/'fast' preference cannot leak in. */
export function executionOptions(runner: RunnerConfig, workdir = "") {
  const cap = executionCapabilities(runner, workdir);
  const desired = normalizeEffort(runner.effort);
  const effort = cap.efforts.includes(desired) ? desired : cap.efforts.includes("medium") ? "medium" : cap.efforts[0] ?? "medium";
  return { effort, fastMode: runner.fastMode === true && cap.fast, ultraMode: runner.ultraMode === true && cap.ultra, fullAccess: runner.fullAccess !== false };
}

export function executionArguments(runner: RunnerConfig, workdir = ""): string[] {
  const value = executionOptions(runner, workdir);
  const full = value.fullAccess && runner.mode !== "plan";
  if (runner.type === "codex") return ["-c", `model_reasoning_effort="${value.ultraMode ? "ultra" : value.effort}"`, "-c", `service_tier="${value.fastMode ? "fast" : "default"}"`, "-c", `features.fast_mode=${value.fastMode}`, ...(full ? ["--dangerously-bypass-approvals-and-sandbox"] : [])];
  if (runner.type === "claude-code") return ["--effort", value.effort, "--settings", JSON.stringify({ fastMode: value.fastMode, ultracode: value.ultraMode }), ...(full ? ["--permission-mode", "bypassPermissions"] : [])];
  return full ? ["--approval-mode", "yolo"] : [];
}
