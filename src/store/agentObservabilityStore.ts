import { create } from "zustand";

export interface AgentToolEvent {
  id: string;
  kind: string;
  title: string;
  detail: string;
  status: string;
  timestamp?: string;
  parentId?: string;
  input?: string;
}

export interface ObservedAgent {
  id: string;
  sessionId: string;
  parentId?: string;
  name: string;
  role?: string;
  provider: string;
  task: string;
  lastMessage: string;
  status: string;
  updatedAt?: number;
  model?: string;
  events: AgentToolEvent[];
  truncated: boolean;
}

export interface AgentObservation {
  sessionId: string;
  agents: ObservedAgent[];
  available: boolean;
  reason?: string;
}

export interface ChatActivityEvent {
  sessionId: string;
  turnId: string;
  kind: string;
  itemId?: string;
  title?: string;
  text?: string;
  status?: string;
  parentId?: string;
  pid?: number;
  command?: string;
  output?: string;
}

interface LiveActivity {
  turnId: string;
  tools: AgentToolEvent[];
  updatedAt: number;
}

export const useAgentObservabilityStore = create<{
  observations: Record<string, AgentObservation>;
  live: Record<string, LiveActivity>;
  updatedAt?: number;
  setObservations: (observations: AgentObservation[]) => void;
  recordChat: (event: ChatActivityEvent) => void;
}>((set) => ({
  observations: {},
  live: {},
  setObservations: observations => set({
    observations: Object.fromEntries(observations.map(observation => [observation.sessionId, observation])),
    updatedAt: Date.now(),
  }),
  recordChat: event => {
    if (!["tool", "done", "error"].includes(event.kind)) return;
    set(state => {
      const previous = state.live[event.sessionId];
      const tools = previous?.tools.slice() ?? [];
      if (event.kind === "tool") {
        const id = `${event.turnId}:${event.parentId ?? ""}:${event.itemId ?? event.title ?? "tool"}`;
        const index = tools.findIndex(tool => tool.id === id);
        const tool: AgentToolEvent = {
          id, kind: "tool", title: event.title ?? tools[index]?.title ?? "Tool", detail: event.output?.slice(-3000) ?? event.text?.slice(0, 3000) ?? tools[index]?.detail ?? "",
          status: event.status ?? "running", timestamp: tools[index]?.timestamp ?? new Date().toISOString(),
          parentId: event.parentId ? `${event.turnId}:${event.parentId}` : tools[index]?.parentId,
          input: event.command?.slice(0, 3000) ?? (event.status === "running" && event.text ? event.text.slice(0, 3000) : tools[index]?.input),
        };
        if (index >= 0) tools[index] = tool;
        else tools.push(tool);
      }
      const live = { ...state.live, [event.sessionId]: { turnId: event.turnId, tools: tools.slice(-60), updatedAt: Date.now() } };
      const keys = Object.keys(live);
      if (keys.length > 100) delete live[keys[0]];
      return { live };
    });
  },
}));
