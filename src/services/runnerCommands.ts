import { invoke } from "@tauri-apps/api/core";
import { useSessionStore, type ClaudeSession } from "../store/sessionStore";
import { useSettingsStore, RUNNER_LABELS, type RunnerConfig, type RunnerType } from "../store/settingsStore";
import { useWorkspaceStore } from "../store/workspaceStore";
import { agentAdapters, getAgentAdapter, supportsAgentResume } from "./agentAdapters";
import { executionOptions } from "./agentExecution";

export const CLI_INSTALL_CMD: Partial<Record<RunnerType, string>> = Object.fromEntries(
  Object.values(agentAdapters).map((adapter) => [adapter.id, adapter.installCommand])
);

export interface SessionRunnerContext {
  sessionId: string;
  runnerType: RunnerType;
}

export function buildRunnerContext(sessionId: string, runnerType: RunnerType): SessionRunnerContext {
  return { sessionId, runnerType };
}

export function hasNativeResumeBinding(
  session: { runner: { type: RunnerType }; providerSessionId?: string } | undefined
): boolean {
  if (!session?.providerSessionId?.trim()) return false;
  return supportsAgentResume(session.runner.type);
}

export function getRunnerBadge(runnerType: RunnerType): string {
  return RUNNER_LABELS[runnerType];
}

export function getRunnerInstallCommand(runnerType: RunnerType): string | undefined {
  return CLI_INSTALL_CMD[runnerType];
}

export function getRunnerCliCommand(runner: RunnerConfig): string {
  return runner.cliPath || getAgentAdapter(runner.type).executable;
}

export async function checkRunnerAvailability(command: string): Promise<boolean> {
  return invoke<boolean>("check_cli", { command });
}

export function switchRunnerForSession(sessionId: string, type: RunnerType) {
  const nextRunner = useSettingsStore.getState().getRunnerConfigForType(type);
  const session = useSessionStore.getState().sessions.find((item) => item.id === sessionId);
  if (session) {
    useSessionStore.getState().updateSession(session.id, { runner: { ...nextRunner } });
  }
  useSettingsStore.getState().patchRunner({ type });
  return nextRunner;
}

export function buildRunnerContextEnv(session: ClaudeSession, runner: RunnerConfig): [string, string][] {
  const workspaces = useWorkspaceStore.getState().workspaces;
  const workspace = workspaces.find((w) => w.id === session.workspaceId);
  const allSessions = useSessionStore.getState().sessions;
  const siblingSessions = allSessions.filter(
    (s) => s.workspaceId === session.workspaceId && s.id !== session.id && s.status === "running"
  );

  const env: [string, string][] = [
    ...(runner.type === "claude-code" ? [["CLAUDE_CODE_EFFORT_LEVEL", executionOptions(runner).effort] as [string, string]] : []),
    ["AGENTDECK_SESSION_ID", session.id],
    ["AGENTDECK_PROVIDER_SESSION_ID", session.providerSessionId ?? ""],
    ["AGENTDECK_RUNNER_TYPE", runner.type],
    ["AGENTDECK_SESSION_NAME", session.name],
    ["AGENTDECK_WORKDIR", session.workdir],
    ["AGENTDECK_PROJECT_ROOT", workspace?.path || session.workdir],
    ["AGENTDECK_WORKSPACE_ID", session.workspaceId],
    ["AGENTDECK_WORKSPACE_NAME", workspace?.name ?? ""],
    ["AGENTDECK_CONCURRENT_SESSIONS", String(siblingSessions.length)],
    ["AGENTDECK_SUGGESTED_BRANCH", session.branchName ?? `ci/session-${session.id}`],
    ...(session.worktreePath ? [
      ["AGENTDECK_WORKTREE_PATH", session.worktreePath] as [string, string],
      ["AGENTDECK_BASE_BRANCH", session.baseBranch ?? ""] as [string, string],
      ["AGENTDECK_BRANCH", session.branchName ?? ""] as [string, string],
    ] : []),
  ];

  return env;
}
