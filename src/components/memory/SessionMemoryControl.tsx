import { BrainCircuit, CircleAlert } from "lucide-react";
import { useAppI18n } from "../../i18n";
import type { RunnerType } from "../../store/settingsStore";
import { useMemoryRuntimeEvents, useMemoryRuntimeStore } from "../../store/memoryRuntimeStore";
import { useSharedMemoryStore } from "../../store/sharedMemoryStore";
import { memoryCopy } from "./memoryCopy";
import "./sharedMemory.css";

export function SessionMemoryControl({ sessionId, provider, projectPath, onOpen }: { sessionId: string; provider: RunnerType; projectPath: string; onOpen: () => void }) {
  useMemoryRuntimeEvents();
  const { locale } = useAppI18n();
  const m = memoryCopy(locale);
  const runtime = useMemoryRuntimeStore(state => state.sessions[sessionId]);
  const context = runtime?.context;
  const details = runtime?.error ? `${m.contextError}: ${runtime.error}` : context
    ? `${m.retrieved}: ${context.recordCount} · ≈ ${context.estimatedTokens} ${m.tokens} · ${m.duplicates}: ${context.duplicateCount}`
    : `${m.viewMemory} · ${projectPath}`;
  return <div className="ad-memory-session-control" data-provider={provider}>
    <button type="button" className="ad-memory-session-button" aria-label={m.viewMemory} title={details} data-error={!!runtime?.error} onClick={() => { useSharedMemoryStore.getState().setMemoryTab("memory"); useSharedMemoryStore.getState().setMemoryScope("project"); onOpen(); }}><BrainCircuit size={14} /><span>{m.short}</span>{runtime?.error ? <span role="status" className="ad-memory-runtime-error"><CircleAlert size={12} /><span>{m.contextError}</span></span> : context && <small title={details}>{context.recordCount}<span aria-hidden="true"> · </span>{`≈${context.estimatedTokens}`}</small>}</button>
  </div>;
}
