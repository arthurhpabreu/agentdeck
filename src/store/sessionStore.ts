import { create } from "zustand";
import { persist } from "zustand/middleware";
import { getI18n } from "../i18n";
import { createDurableJSONStorage } from "./persistStorage";
import { useSettingsStore, type RunnerConfig } from "./settingsStore";

// ── Type definitions ─────────────────────────────────────────

export type SessionStatus = "idle" | "running" | "waiting" | "suspended" | "done" | "error";

export interface DiffFile {
  path: string;
  type: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  binary?: boolean;
  note?: string;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  header: string;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "context" | "added" | "deleted";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface ClaudeSession {
  id: string;
  name: string;
  nameIsCustom?: boolean; // Older sessions keep automatic naming until explicitly renamed.
  workspaceId: string;   // Owning workspace ID.
  workdir: string;       // Stored redundantly so it can be passed directly to the PTY.
  status: SessionStatus;
  currentTask: string;
  createdAt: number;
  diffFiles: DiffFile[];
  output: string[];
  runner: RunnerConfig;
  pid?: number;
  branchName?: string;     // Git branch the agent uses in this session (for example, ci/1a2b3c/session-3).
  baseBranch?: string;     // Base branch at task start (for example, main/master).
  worktreePath?: string;   // Git worktree path.
  providerSessionId?: string; // Bound native provider session ID, used by Codex/Claude resume.
}

interface SessionStore {
  sessions: ClaudeSession[];
  activeSessionId: string | null;
  expandedSessionId: string | null;
  sessionOrderByWorkspace: Record<string, string[]>;
  splitDetailItemId: string;
  splitCardItemIdsBySlot: Record<string, string>;

  // worktreeReady tracks whether worktree creation finished or the directory is not a Git repository.
  // Not persisted; reset at startup and inferred from worktreePath when reopening persisted sessions.
  worktreeReadyIds: Set<string>;

  addSession: (id: string, workspaceId: string, workdir: string, name: string | undefined, runner: RunnerConfig) => string;
  removeSession: (id: string) => void;
  setActiveSession: (id: string | null) => void;
  updateSession: (id: string, patch: Partial<ClaudeSession>) => void;
  renameSession: (id: string, name: string) => boolean;
  setAutomaticSessionName: (id: string, name: string) => void;
  appendOutput: (id: string, line: string) => void;
  clearOutput: (id: string) => void;
  setDiffFiles: (id: string, files: DiffFile[]) => void;
  setExpandedSession: (id: string | null) => void;
  removeSessionsByWorkspace: (workspaceId: string) => void;
  markWorktreeReady: (id: string) => void;
  mergeRecoveredSessions: (sessions: ClaudeSession[]) => void;
  reorderWorkspaceSessions: (workspaceId: string, orderedSessionIds: string[]) => void;
  reorderWorkspaceSessionsByVisibleMove: (workspaceId: string, activeId: string, overId: string) => void;
  swapSplitDetailWithCard: (slotId: string) => void;
}

// ── Factory functions ─────────────────────────────────────────

const STATUS_PRIORITY: Partial<Record<SessionStatus, number>> = {
  waiting: 0,
  running: 1,
  suspended: 2,
};

function getStatusPriority(status: SessionStatus): number {
  return STATUS_PRIORITY[status] ?? 3;
}

function dedupeSessionIds(ids: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const id of ids) {
    if (seen.has(id)) continue;
    seen.add(id);
    deduped.push(id);
  }

  return deduped;
}

function normalizeSessionIdentityValue(value: string | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function isSameLogicalSession(existing: ClaudeSession, incoming: ClaudeSession): boolean {
  const existingWorktree = normalizeSessionIdentityValue(existing.worktreePath);
  const incomingWorktree = normalizeSessionIdentityValue(incoming.worktreePath);
  if (existingWorktree && incomingWorktree) {
    return existing.workspaceId === incoming.workspaceId && existingWorktree === incomingWorktree;
  }

  const existingProviderSessionId = normalizeSessionIdentityValue(existing.providerSessionId);
  const incomingProviderSessionId = normalizeSessionIdentityValue(incoming.providerSessionId);
  if (existingProviderSessionId && incomingProviderSessionId) {
    return existing.workspaceId === incoming.workspaceId
      && existing.runner.type === incoming.runner.type
      && existingProviderSessionId === incomingProviderSessionId;
  }

  const existingBranchName = normalizeSessionIdentityValue(existing.branchName);
  const incomingBranchName = normalizeSessionIdentityValue(incoming.branchName);
  if (existingBranchName && incomingBranchName) {
    return existing.workspaceId === incoming.workspaceId && existingBranchName === incomingBranchName;
  }

  return existing.workspaceId === incoming.workspaceId && existing.createdAt === incoming.createdAt;
}

function buildWorkspaceManualOrder(
  sessions: ClaudeSession[],
  workspaceId: string,
  persistedOrder: string[] | undefined
): string[] {
  const workspaceSessions = sessions.filter((s) => s.workspaceId === workspaceId);
  const workspaceIds = workspaceSessions.map((s) => s.id);
  const validSet = new Set(workspaceIds);
  const normalizedPersisted = dedupeSessionIds(
    (persistedOrder ?? []).filter((id) => validSet.has(id))
  );
  const normalizedSet = new Set(normalizedPersisted);
  const missing = workspaceIds.filter((id) => !normalizedSet.has(id));
  return [...normalizedPersisted, ...missing];
}

export function orderWorkspaceSessions(
  sessions: ClaudeSession[],
  workspaceId: string,
  sessionOrderByWorkspace: Record<string, string[]>
): ClaudeSession[] {
  const workspaceSessions = sessions.filter((s) => s.workspaceId === workspaceId);
  const manualOrder = buildWorkspaceManualOrder(
    sessions,
    workspaceId,
    sessionOrderByWorkspace[workspaceId]
  );
  const manualIndex = new Map(manualOrder.map((id, index) => [id, index]));

  return [...workspaceSessions].sort((a, b) => {
    const priorityDelta = getStatusPriority(a.status) - getStatusPriority(b.status);
    if (priorityDelta !== 0) return priorityDelta;

    const aIndex = manualIndex.get(a.id) ?? Number.MAX_SAFE_INTEGER;
    const bIndex = manualIndex.get(b.id) ?? Number.MAX_SAFE_INTEGER;
    if (aIndex !== bIndex) return aIndex - bIndex;

    return a.createdAt - b.createdAt;
  });
}

function resolveRunnerField(current: string | undefined, fallback: string | undefined): string | undefined {
  return current && current.trim() ? current : fallback;
}

function hydrateRunnerConfig(runner: RunnerConfig): RunnerConfig {
  const resolved = useSettingsStore.getState().getRunnerConfigForType(runner.type);
  return {
    type: runner.type,
    cliPath: resolveRunnerField(runner.cliPath, resolved.cliPath),
    cliArgs: resolveRunnerField(runner.cliArgs, resolved.cliArgs),
  };
}

function makeSession(
  overrides: Partial<Omit<ClaudeSession, "runner">> & { id: string; workspaceId: string; workdir: string; runner: RunnerConfig }
): ClaudeSession {
  const i18n = getI18n();
  return {
    name: i18n.isInitialized
      ? i18n.t("session.defaultName", { id: overrides.id })
      : `Session ${overrides.id}`,
    status: "idle",
    currentTask: "",
    createdAt: Date.now(),
    diffFiles: [],
    output: [],
    ...overrides,
    runner: hydrateRunnerConfig(overrides.runner),
  };
}

// ── Store ─────────────────────────────────────────────────────

const EMPTY_VOLATILE: never[] = [];
const navigationSessions = new Map<string, ClaudeSession>();
const navigationByInstance = new WeakMap<ClaudeSession, ClaudeSession>();
const metadataByInstance = new WeakMap<ClaudeSession, ClaudeSession>();
const metadataSessions = new Map<string, ClaudeSession>();
let navigationProjection: ClaudeSession[] = [];
/** Navigation subscribes to session identity/status, while heavy output and diff payloads stay local. */
export function selectSessionNavigation(state: Pick<SessionStore, "sessions">): ClaudeSession[] {
  const next = state.sessions.map(session => {
    const cached = navigationByInstance.get(session); if (cached) return cached;
    const { output: _output, diffFiles: _diffFiles, ...metadata } = session;
    const projected = { ...metadata, output: EMPTY_VOLATILE, diffFiles: EMPTY_VOLATILE };
    const previous = navigationSessions.get(session.id);
    if (previous && Object.keys(projected).length === Object.keys(previous).length && Object.entries(projected).every(([key, value]) => previous[key as keyof ClaudeSession] === value)) { navigationByInstance.set(session, previous); return previous; }
    navigationSessions.set(session.id, projected);
    navigationByInstance.set(session, projected);
    return projected;
  });
  const valid = new Set(next.map(session => session.id));
  for (const id of navigationSessions.keys()) if (!valid.has(id)) navigationSessions.delete(id);
  if (next.length === navigationProjection.length && next.every((session, index) => session === navigationProjection[index])) return navigationProjection;
  navigationProjection = next;
  return next;
}
export function selectSessionMetadata(state: Pick<SessionStore, "sessions">, id: string): ClaudeSession | undefined {
  const session = state.sessions.find(item => item.id === id); if (!session) { metadataSessions.delete(id); return undefined; }
  const cached = metadataByInstance.get(session); if (cached) return cached;
  const projected = { ...session, output: EMPTY_VOLATILE };
  const previous = metadataSessions.get(id);
  const next = previous && Object.keys(previous).length === Object.keys(projected).length && Object.entries(projected).every(([key, value]) => previous[key as keyof ClaudeSession] === value) ? previous : projected;
  metadataByInstance.set(session, next); metadataSessions.set(id, next); return next;
}
const durableSessions = new Map<string, ClaudeSession>();
const durableByInstance = new WeakMap<ClaudeSession, ClaudeSession>();
let durableProjection: { sessions: ClaudeSession[]; activeSessionId: string | null; sessionOrderByWorkspace: Record<string, string[]> } | undefined;
function projectDurableState(state: SessionStore) {
  const projected = state.sessions.map(session => {
    const cached = durableByInstance.get(session); if (cached) return cached;
    const { output: _output, diffFiles: _diffFiles, pid: _pid, ...metadata } = session;
    const next: ClaudeSession = { ...metadata, status: session.status === "running" || session.status === "waiting" ? "idle" : session.status, diffFiles: EMPTY_VOLATILE, output: EMPTY_VOLATILE };
    const previous = durableSessions.get(session.id);
    if (previous && Object.keys(next).length === Object.keys(previous).length && Object.entries(next).every(([key, value]) => previous[key as keyof ClaudeSession] === value)) { durableByInstance.set(session, previous); return previous; }
    durableSessions.set(session.id, next);
    durableByInstance.set(session, next);
    return next;
  });
  const valid = new Set(state.sessions.map(session => session.id));
  for (const id of durableSessions.keys()) if (!valid.has(id)) durableSessions.delete(id);
  if (durableProjection && durableProjection.activeSessionId === state.activeSessionId && durableProjection.sessionOrderByWorkspace === state.sessionOrderByWorkspace && projected.length === durableProjection.sessions.length && projected.every((session, i) => session === durableProjection!.sessions[i])) return durableProjection;
  durableProjection = { sessions: projected, activeSessionId: state.activeSessionId, sessionOrderByWorkspace: state.sessionOrderByWorkspace };
  return durableProjection;
}

export const useSessionStore = create<SessionStore>()(
  persist(
    (set, get) => ({
      sessions: [],
      activeSessionId: null,
      expandedSessionId: null,
      sessionOrderByWorkspace: {},
      splitDetailItemId: "session-detail",
      splitCardItemIdsBySlot: {},
      worktreeReadyIds: new Set<string>(),

      addSession: (id, workspaceId, workdir, name, runner) => {
        const s = makeSession({
          id,
          workspaceId,
          workdir,
          ...(name ? { name } : {}),
          runner: { ...runner },
        });
        set((state) => ({
          sessions: [...state.sessions, s],
          activeSessionId: s.id,
          sessionOrderByWorkspace: {
            ...state.sessionOrderByWorkspace,
            [workspaceId]: [...(state.sessionOrderByWorkspace[workspaceId] ?? []), s.id],
          },
        }));
        return s.id;
      },

      removeSession: (id) =>
        set((state) => {
          const sessions = state.sessions.filter((s) => s.id !== id);
          const activeSessionId =
            state.activeSessionId === id
              ? (sessions[0]?.id ?? null)
              : state.activeSessionId;
          const expandedSessionId =
            state.expandedSessionId === id
              ? null
              : state.expandedSessionId;
          const worktreeReadyIds = new Set(state.worktreeReadyIds);
          worktreeReadyIds.delete(id);
          const sessionOrderByWorkspace = Object.fromEntries(
            Object.entries(state.sessionOrderByWorkspace).map(([workspaceId, ids]) => [
              workspaceId,
              ids.filter((sid) => sid !== id),
            ])
          );
          const removedItemId = `session-${id}`;
          const splitDetailItemId = state.splitDetailItemId === removedItemId
            ? "session-detail"
            : state.splitDetailItemId;
          const splitCardItemIdsBySlot = Object.fromEntries(
            Object.entries(state.splitCardItemIdsBySlot).filter(([, itemId]) => itemId !== removedItemId)
          );
          return {
            sessions,
            activeSessionId,
            expandedSessionId,
            worktreeReadyIds,
            sessionOrderByWorkspace,
            splitDetailItemId,
            splitCardItemIdsBySlot,
          };
        }),

      setActiveSession: (id) =>
        set({ activeSessionId: id }),

      setExpandedSession: (id) =>
        set({ expandedSessionId: id }),

      updateSession: (id, patch) =>
        set((state) => {
          const existing = state.sessions.find(session => session.id === id);
          if (!existing || Object.entries(patch).every(([key, value]) => existing[key as keyof ClaudeSession] === value)) return state;
          return { sessions: state.sessions.map(s => s.id === id ? { ...s, ...patch } : s) };
        }),

      renameSession: (id, name) => {
        const normalized = name.replace(/\s+/g, " ").trim();
        if (!normalized || normalized.length > 120 || !get().sessions.some(s => s.id === id)) return false;
        set(state => ({ sessions: state.sessions.map(s => s.id === id
          ? { ...s, name: normalized, nameIsCustom: true } : s) }));
        return true;
      },

      setAutomaticSessionName: (id, name) => {
        if (!name.trim()) return;
        set(state => ({ sessions: state.sessions.map(s => s.id === id && !s.nameIsCustom
          ? { ...s, name } : s) }));
      },

      appendOutput: (id, line) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id
              ? { ...s, output: [...s.output.slice(-299), line] }
              : s
          ),
        })),

      clearOutput: (id) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, output: [] } : s
          ),
        })),

      setDiffFiles: (id, files) =>
        set((state) => ({
          sessions: state.sessions.map((s) =>
            s.id === id ? { ...s, diffFiles: files } : s
          ),
        })),

      removeSessionsByWorkspace: (workspaceId) =>
        set((state) => {
          const sessions = state.sessions.filter((s) => s.workspaceId !== workspaceId);
          const activeSessionId =
            state.sessions.find((s) => s.id === state.activeSessionId)?.workspaceId === workspaceId
              ? (sessions[0]?.id ?? null)
              : state.activeSessionId;
          const expandedSessionId =
            state.sessions.find((s) => s.id === state.expandedSessionId)?.workspaceId === workspaceId
              ? null
              : state.expandedSessionId;
          const removedIds = state.sessions
            .filter((s) => s.workspaceId === workspaceId)
            .map((s) => s.id);
          const removedItemIds = new Set(removedIds.map((id) => `session-${id}`));
          const worktreeReadyIds = new Set(state.worktreeReadyIds);
          removedIds.forEach((id) => worktreeReadyIds.delete(id));
          const { [workspaceId]: _, ...restOrder } = state.sessionOrderByWorkspace;
          const splitDetailItemId = removedItemIds.has(state.splitDetailItemId)
            ? "session-detail"
            : state.splitDetailItemId;
          const splitCardItemIdsBySlot = Object.fromEntries(
            Object.entries(state.splitCardItemIdsBySlot).filter(([, itemId]) => !removedItemIds.has(itemId))
          );
          return {
            sessions,
            activeSessionId,
            expandedSessionId,
            worktreeReadyIds,
            sessionOrderByWorkspace: restOrder,
            splitDetailItemId,
            splitCardItemIdsBySlot,
          };
        }),

      markWorktreeReady: (id) =>
        set((state) => {
          const worktreeReadyIds = new Set(state.worktreeReadyIds);
          worktreeReadyIds.add(id);
          return { worktreeReadyIds };
        }),

      mergeRecoveredSessions: (recoveredSessions) =>
        set((state) => {
          if (recoveredSessions.length === 0) return {};

          const sessions = [...state.sessions];
          const worktreeReadyIds = new Set(state.worktreeReadyIds);
          const sessionOrderByWorkspace = { ...state.sessionOrderByWorkspace };
          let added = false;
          let merged = false;
          let firstRecoveredSessionId: string | null = null;

          for (const recovered of recoveredSessions) {
            const hydratedRecovered: ClaudeSession = {
              ...recovered,
              runner: hydrateRunnerConfig(recovered.runner),
              diffFiles: [...recovered.diffFiles],
              output: [...recovered.output],
            };
            firstRecoveredSessionId ??= hydratedRecovered.id;

            const existingIndex = sessions.findIndex((session) => session.id === hydratedRecovered.id);
            if (existingIndex >= 0) {
              const existingSession = sessions[existingIndex];
              if (!isSameLogicalSession(existingSession, hydratedRecovered)) {
                console.warn("[session-store] skip recovered session with conflicting duplicate id", {
                  sessionId: hydratedRecovered.id,
                  existingWorkspaceId: existingSession.workspaceId,
                  recoveredWorkspaceId: hydratedRecovered.workspaceId,
                  existingWorktreePath: existingSession.worktreePath,
                  recoveredWorktreePath: hydratedRecovered.worktreePath,
                  existingProviderSessionId: existingSession.providerSessionId,
                  recoveredProviderSessionId: hydratedRecovered.providerSessionId,
                });
                continue;
              }

              sessions[existingIndex] = {
                ...existingSession,
                ...hydratedRecovered,
                runner: hydrateRunnerConfig(hydratedRecovered.runner),
                diffFiles: [...hydratedRecovered.diffFiles],
                output: [...hydratedRecovered.output],
                ...(existingSession.nameIsCustom ? { name: existingSession.name, nameIsCustom: true } : {}),
              };
              merged = true;
            } else {
              sessions.push(hydratedRecovered);
              added = true;
            }

            if (hydratedRecovered.worktreePath) {
              worktreeReadyIds.add(hydratedRecovered.id);
            }

            const workspaceId = hydratedRecovered.workspaceId;
            const nextOrder = [...(sessionOrderByWorkspace[workspaceId] ?? []), hydratedRecovered.id];
            sessionOrderByWorkspace[workspaceId] = buildWorkspaceManualOrder(
              sessions,
              workspaceId,
              nextOrder
            );
          }

          if (!added && !merged) return {};

          return {
            sessions,
            worktreeReadyIds,
            sessionOrderByWorkspace,
            activeSessionId: state.activeSessionId ?? firstRecoveredSessionId,
          };
        }),

      reorderWorkspaceSessions: (workspaceId, orderedSessionIds) =>
        set((state) => {
          const manualOrder = buildWorkspaceManualOrder(
            state.sessions,
            workspaceId,
            orderedSessionIds
          );
          return {
            sessionOrderByWorkspace: {
              ...state.sessionOrderByWorkspace,
              [workspaceId]: manualOrder,
            },
          };
        }),

      reorderWorkspaceSessionsByVisibleMove: (workspaceId, activeId, overId) =>
        set((state) => {
          const visibleOrdered = orderWorkspaceSessions(
            state.sessions,
            workspaceId,
            state.sessionOrderByWorkspace
          );
          const oldIndex = visibleOrdered.findIndex((s) => s.id === activeId);
          const newIndex = visibleOrdered.findIndex((s) => s.id === overId);
          if (oldIndex < 0 || newIndex < 0 || oldIndex === newIndex) return {};

          const activeSession = visibleOrdered[oldIndex];
          const overSession = visibleOrdered[newIndex];
          const activePriority = getStatusPriority(activeSession.status);
          const overPriority = getStatusPriority(overSession.status);
          if (activePriority !== overPriority) return {};

          const sameGroupVisible = visibleOrdered.filter(
            (session) => getStatusPriority(session.status) === activePriority
          );
          const groupOldIndex = sameGroupVisible.findIndex((s) => s.id === activeId);
          const groupNewIndex = sameGroupVisible.findIndex((s) => s.id === overId);
          if (groupOldIndex < 0 || groupNewIndex < 0 || groupOldIndex === groupNewIndex) return {};

          const movedGroup = [...sameGroupVisible];
          const [moved] = movedGroup.splice(groupOldIndex, 1);
          movedGroup.splice(groupNewIndex, 0, moved);
          const movedGroupIds = movedGroup.map((s) => s.id);
          const movedGroupIndex = new Map(movedGroupIds.map((id, index) => [id, index]));

          const manualOrder = buildWorkspaceManualOrder(
            state.sessions,
            workspaceId,
            state.sessionOrderByWorkspace[workspaceId]
          );
          const nextOrder = [...manualOrder].sort((a, b) => {
            const aIdx = movedGroupIndex.get(a);
            const bIdx = movedGroupIndex.get(b);
            if (aIdx === undefined && bIdx === undefined) return 0;
            if (aIdx === undefined) return 1;
            if (bIdx === undefined) return -1;
            return aIdx - bIdx;
          });

          if (nextOrder.every((id, index) => id === manualOrder[index])) {
            return {};
          }

          return {
            sessionOrderByWorkspace: {
              ...state.sessionOrderByWorkspace,
              [workspaceId]: nextOrder,
            },
          };
        }),

      swapSplitDetailWithCard: (slotId) =>
        set((state) => {
          const cardItemId = state.splitCardItemIdsBySlot[slotId] ?? slotId;
          const detailItemId = state.splitDetailItemId;
          if (cardItemId === detailItemId) return {};
          return {
            splitDetailItemId: cardItemId,
            splitCardItemIdsBySlot: {
              ...state.splitCardItemIdsBySlot,
              [slotId]: detailItemId,
            },
          };
        }),
    }),
    {
      name: "agentdeck-sessions",
      storage: createDurableJSONStorage<ReturnType<typeof projectDurableState>>(),
      // expandedSessionId and worktreeReadyIds are not persisted.
      partialize: projectDurableState,
      // On restore, mark sessions with an existing worktreePath as worktreeReady.
      // Their worktrees may exist or have been orphan-cleaned; reuse the persisted path without creating another.
      onRehydrateStorage: () => (state) => {
        if (!state) return;
        const sessionIdCounts = new Map<string, number>();
        for (const session of state.sessions) {
          sessionIdCounts.set(session.id, (sessionIdCounts.get(session.id) ?? 0) + 1);
        }
        const duplicateSessionIds = [...sessionIdCounts.entries()]
          .filter(([, count]) => count > 1)
          .map(([id]) => id);
        if (duplicateSessionIds.length > 0) {
          console.warn("[session-store] duplicate session ids found during rehydrate", {
            sessionIds: duplicateSessionIds,
          });
        }

        // Persisted sessions with worktreePath use an existing filesystem worktree, validated by startup cleanup.
        // Mark them ready directly without recreating the worktree.
        const readyIds = new Set<string>(
          state.sessions.filter((s) => s.workdir?.trim()).map((s) => s.id)
        );
        state.worktreeReadyIds = readyIds;

        // Repair each workspace's session order: add missing sessions and remove invalid entries.
        const byWorkspace = state.sessions.reduce<Record<string, string[]>>((acc, s) => {
          acc[s.workspaceId] = [...(acc[s.workspaceId] ?? []), s.id];
          return acc;
        }, {});
        const normalizedOrder: Record<string, string[]> = {};
        for (const [workspaceId, ids] of Object.entries(byWorkspace)) {
          const validSet = new Set(ids);
          const persisted = dedupeSessionIds(
            (state.sessionOrderByWorkspace?.[workspaceId] ?? []).filter((id) => validSet.has(id))
          );
          const persistedSet = new Set(persisted);
          const missing = ids.filter((id) => !persistedSet.has(id));
          normalizedOrder[workspaceId] = [...persisted, ...missing];
        }
        state.sessionOrderByWorkspace = normalizedOrder;
      },
    }
  )
);
