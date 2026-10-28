import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";
import { mirroredPersistStorage } from "./persistStorage";
import { createUuid } from "../services/ids";
import { nextScheduleRun, type ScheduleTiming } from "../services/promptScheduleTime";

export interface PromptSchedule extends ScheduleTiming {
  id: string; sessionId: string; identity: string; prompt: string; enabled: boolean;
  nextRunAt?: number; lastRunAt?: number; lastResult?: "started" | "failed" | "missed" | "interrupted";
  error?: string;
}
export const usePromptScheduleStore = create<{
  schedules: PromptSchedule[];
  add: (schedule: Omit<PromptSchedule, "id" | "enabled" | "nextRunAt">) => void;
  update: (id: string, patch: Partial<PromptSchedule>) => void;
  remove: (id: string) => void;
}>()(persist(set => ({
  schedules: [],
  add: schedule => set(state => ({ schedules: [...state.schedules, { ...schedule, id: createUuid(), enabled: true, nextRunAt: nextScheduleRun(schedule, Date.now()) }] })),
  update: (id, patch) => set(state => ({ schedules: state.schedules.map(schedule => schedule.id === id ? { ...schedule, ...patch } : schedule) })),
  remove: id => set(state => ({ schedules: state.schedules.filter(schedule => schedule.id !== id) })),
}), { name: "agentdeck-prompt-schedules-v1", storage: createJSONStorage(() => mirroredPersistStorage) }));
