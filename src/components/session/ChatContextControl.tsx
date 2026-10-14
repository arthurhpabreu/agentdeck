import { ArrowRight, LoaderCircle, Minimize2 } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { compactionPolicy, getCompactionBudget } from "../../services/chatCompaction";
import { emptyThread, useChatStore } from "../../store/chatStore";
import { contextCopy } from "./contextCopy";

export function ChatContextControl({ sessionId, disabled, continuationDisabled, continuing, onContinue }: { sessionId: string; disabled: boolean; continuationDisabled?: boolean; continuing?: boolean; onContinue: () => void }) {
  const { locale } = useAppI18n(); const c = contextCopy(locale);
  const thread = useChatStore(s => s.threads[sessionId] ?? emptyThread); const policy = compactionPolicy(thread.compactionPolicy);
  const nextPrompt = thread.goal?.trim() && thread.goal.trim() !== thread.lastSentGoal ? `Conversation goal:\n${thread.goal.trim()}\n\n${thread.draft}` : thread.draft;
  const budget = getCompactionBudget(thread, nextPrompt);
  const format = (value: number) => Math.round(value).toLocaleString(locale);
  const patch = (value: Partial<typeof policy>) => useChatStore.getState().patch(sessionId, { compactionPolicy: compactionPolicy({ ...policy, ...value }) });
  return <details className="ad-chat-context"><summary title={thread.compacting ? c.compacting : c.context} aria-label={c.context}><Minimize2 size={14} /><span>{c.context}</span></summary><div role="group" aria-label={c.context}>
    <label><span>{c.automatic}</span><input type="checkbox" role="switch" aria-label={c.automatic} checked={policy.enabled} disabled={disabled || thread.busy} onChange={e => patch({ enabled: e.target.checked })} /></label>
    <label>{c.prompts}<input type="number" aria-label={c.prompts} min={5} max={100} step={1} value={policy.maxPrompts} disabled={disabled || thread.busy || !policy.enabled} onChange={e => { if (e.currentTarget.value) patch({ maxPrompts: e.currentTarget.valueAsNumber }); }} /></label>
    <label>{c.tokens}<input type="number" aria-label={c.tokens} min={8000} max={500000} step={1000} value={policy.maxTokens} disabled={disabled || thread.busy || !policy.enabled} onChange={e => { if (e.currentTarget.value) patch({ maxTokens: e.currentTarget.valueAsNumber }); }} /></label>
    <p>{disabled ? c.unsupported : c.hint}</p>
    <small>{thread.contextPrompts ?? 0} {c.promptsSince}<br />{format(thread.contextTokens ?? 0)} {thread.contextTokensEstimated !== false ? c.estimated : c.measured}<br />{c.compacted}: {thread.compactionCount ?? 0}</small>
    {!disabled && <div className="ad-context-budget">
      {budget.contextWindow && <><label>{c.window}<span>{format(budget.contextWindow)}</span></label><progress aria-label={c.next} max={budget.contextWindow} value={Math.min(budget.projectedTokens, budget.contextWindow)} /></>}
      <label>{c.next}<span>{format(budget.projectedTokens)}</span></label>
      <label>{c.effective}<span>{format(budget.tokenLimit)}</span></label>
      {!!budget.reserveTokens && <label>{c.reserve}<span>{format(budget.reserveTokens)}</span></label>}
      {budget.promptTooLarge && <p role="status" className="ad-context-pressure">{c.largePrompt}</p>}
    </div>}
    {!disabled && <div className="ad-context-continuation"><p>{c.continueHint}</p><button type="button" className="ad-button" disabled={thread.busy || continuing || continuationDisabled || !thread.messages.length} onClick={onContinue}>{continuing ? <LoaderCircle size={14} className="ad-spin" /> : <ArrowRight size={14} />}{continuing ? c.continuing : c.continueChat}</button></div>}
  </div></details>;
}
