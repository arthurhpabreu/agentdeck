import { Minimize2 } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { compactionPolicy } from "../../services/chatCompaction";
import { emptyThread, useChatStore } from "../../store/chatStore";
import { contextCopy } from "./contextCopy";

export function ChatContextControl({ sessionId, disabled }: { sessionId: string; disabled: boolean }) {
  const { locale } = useAppI18n(); const c = contextCopy(locale);
  const thread = useChatStore(s => s.threads[sessionId] ?? emptyThread); const policy = compactionPolicy(thread.compactionPolicy);
  const patch = (value: Partial<typeof policy>) => useChatStore.getState().patch(sessionId, { compactionPolicy: compactionPolicy({ ...policy, ...value }) });
  return <details className="ad-chat-context"><summary title={thread.compacting ? c.compacting : c.context} aria-label={c.context}><Minimize2 size={14} /><span>{c.context}</span></summary><div role="group" aria-label={c.context}>
    <label><span>{c.automatic}</span><input type="checkbox" role="switch" aria-label={c.automatic} checked={policy.enabled} disabled={disabled || thread.busy} onChange={e => patch({ enabled: e.target.checked })} /></label>
    <label>{c.prompts}<input type="number" aria-label={c.prompts} min={5} max={100} step={1} value={policy.maxPrompts} disabled={disabled || thread.busy || !policy.enabled} onChange={e => { if (e.currentTarget.value) patch({ maxPrompts: e.currentTarget.valueAsNumber }); }} /></label>
    <label>{c.tokens}<input type="number" aria-label={c.tokens} min={8000} max={500000} step={1000} value={policy.maxTokens} disabled={disabled || thread.busy || !policy.enabled} onChange={e => { if (e.currentTarget.value) patch({ maxTokens: e.currentTarget.valueAsNumber }); }} /></label>
    <p>{disabled ? c.unsupported : c.hint}</p>
    <small>{thread.contextPrompts ?? 0} {c.promptsSince}<br />{Math.round(thread.contextTokens ?? 0).toLocaleString(locale)} {thread.contextTokensEstimated !== false ? c.estimated : c.measured}<br />{c.compacted}: {thread.compactionCount ?? 0}</small>
  </div></details>;
}
