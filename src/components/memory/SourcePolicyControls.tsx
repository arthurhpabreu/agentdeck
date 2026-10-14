import { useEffect, useRef, useState } from "react";
import { useAppI18n } from "../../i18n";
import { knowledgeCommands, sourcePolicyCommands, type KnowledgeVault, type SourcePolicy, type SourceSelection, type MemoryCollection } from "../../services/knowledgeCommands";
import { memoryCommands, GLOBAL_MEMORY_KEY, type MemoryRecord } from "../../services/memoryCommands";
import { SortableCollection } from "../ordering/SortableCollection";
import { sourcePolicyCopy } from "./sourcePolicyCopy";
import "./sourcePolicy.css";
import { notifySourcePolicyChange, subscribeSourcePolicyChanges } from "../../services/sourcePolicyEvents";

export function SourcePolicyControls({ projectPath, sessionId, catalog = false, deliveredRevision, deliveredRevisions, onInspect, onCorrectSources }: {
  projectPath?: string; sessionId?: string; catalog?: boolean; deliveredRevision?: number; deliveredRevisions?: number[]; onInspect?: (sourceId: string) => void; onCorrectSources?: () => void;
}) {
  const { locale } = useAppI18n(); const c = sourcePolicyCopy(locale);
  const [policy, setPolicy] = useState<SourcePolicy | null>(null);
  const [error, setError] = useState(""); const [busy, setBusy] = useState(false);
  const [draft, setDraft] = useState<KnowledgeVault | null>(null);
  const [collection, setCollection] = useState<MemoryCollection | null>(null);
  const [records, setRecords] = useState<MemoryRecord[]>([]);
  const generation = useRef(0); const mounted = useRef(true);
  const load = async () => {
    const version = ++generation.current;
    try { const next = await sourcePolicyCommands.get(projectPath, sessionId); if (mounted.current && version === generation.current) { setPolicy(next); setError(""); } }
    catch (cause) { if (mounted.current && version === generation.current) setError(String(cause)); }
  };
  useEffect(() => {
    mounted.current = true; void load();
    const changed = () => { void load(); };
    const remove = subscribeSourcePolicyChanges(changed);
    return () => { mounted.current = false; generation.current++; remove(); };
  }, [projectPath, sessionId]);
  const action = async (operation: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(true); setError(""); generation.current++;
    try { await operation(); if (mounted.current) { await load(); notifySourcePolicyChange(); } }
    catch (cause) { if (mounted.current) setError(String(cause)); }
    finally { if (mounted.current) setBusy(false); }
  };
  const select = (selection: SourceSelection | null) => {
    if (!projectPath) return;
    void action(() => sessionId ? sourcePolicyCommands.setConversation(projectPath, sessionId, selection) : sourcePolicyCommands.setProject(projectPath, selection ?? { sourceIds: [], personalPreferences: false, memoryCollectionIds: [] }));
  };
  const toggle = (field: "sourceIds" | "memoryCollectionIds", id: string) => {
    if (!policy) return;
    const previous = policy.selection[field];
    select({ ...policy.selection, [field]: previous.includes(id) ? previous.filter(value => value !== id) : [...previous, id] });
  };
  const context = `${projectPath ?? "catalog"}:${sessionId ?? "project"}`;
  return <section className="ad-source-policy" aria-label={catalog ? c.catalog : c.title} aria-busy={busy}>
    <h3>{catalog ? c.catalog : c.title}</h3>
    {catalog && <p>{c.intro}</p>}
    {error && <p role="alert" className="ad-documents-error">{error}</p>}
    {!policy ? <span role="status">…</span> : <>
      {!catalog && sessionId && <label>{c.title}<select disabled={busy} value={policy.inheritProject ? "inherit" : "custom"} onChange={event => select(event.target.value === "inherit" ? null : { ...policy.selection })}><option value="inherit">{c.inherit}</option><option value="custom">{c.custom}</option></select></label>}
      {!catalog && !projectPath && <p>{c.noProject}</p>}
      <SortableCollection surface={catalog ? "vault-catalog" : "selected-sources"} context={catalog ? "global" : context} items={policy.vaults} getId={vault => vault.id} getLabel={vault => vault.name} render={(vault, handle) => <div className="ad-source-row">
        {handle}
        {!catalog && <input type="checkbox" aria-label={`${c.selected}: ${vault.name}`} checked={policy.selection.sourceIds.includes(vault.id)} disabled={busy || !projectPath} onChange={() => toggle("sourceIds", vault.id)} />}
        <div className="ad-source-label"><strong title={vault.name}>{vault.name}</strong><small title={vault.path}>{vault.path}</small><span>{c[vault.mode]}{vault.allowedPaths.length ? ` · ${vault.allowedPaths.join(", ")}` : ""}</span></div>
        {onInspect && <button type="button" className="ad-button" onClick={() => onInspect(vault.id)} disabled={!catalog && (!policy.selection.sourceIds.includes(vault.id) || vault.mode === "disabled")}>{c.inspect}</button>}
        {catalog && <><button type="button" className="ad-button" disabled={busy} onClick={() => setDraft({ ...vault, allowedPaths: [...vault.allowedPaths] })}>{c.edit}</button><button type="button" className="ad-button" disabled={busy} onClick={() => void action(() => sourcePolicyCommands.removeVault(vault.id))}>{c.remove}</button></>}
      </div>} />
      {!catalog && !policy.selection.sourceIds.length && <p>{c.none}</p>}
      {!!policy.missingSourceIds.length && <div role="status"><p>{c.missing} <code>{policy.missingSourceIds.join(", ")}</code></p>{!catalog && <button type="button" className="ad-button" disabled={busy} onClick={() => select({ ...policy.selection, sourceIds: policy.selection.sourceIds.filter(id => policy.vaults.some(vault => vault.id === id)) })}>{c.remove}</button>}</div>}
      {!catalog && projectPath && <>
        <label className="ad-source-checkbox"><input type="checkbox" checked={policy.selection.personalPreferences} disabled={busy} onChange={event => select({ ...policy.selection, personalPreferences: event.target.checked })} />{c.personal}</label><p className="ad-source-hint">{c.personalHint}</p>
        <h4>{c.collections}</h4>
        <SortableCollection surface="memory-collections" context={context} items={policy.memoryCollections} getId={item => item.id} getLabel={item => item.name} render={(item, handle) => <label className="ad-source-checkbox">{handle}<input type="checkbox" disabled={busy} checked={policy.selection.memoryCollectionIds.includes(item.id)} onChange={() => toggle("memoryCollectionIds", item.id)} />{item.name}<small>{item.recordIds.length}</small></label>} />
      </>}
      {catalog && <div className="ad-source-actions"><button type="button" className="ad-button" disabled={busy} onClick={() => setDraft({ id: "", name: "", path: "", mode: "automatic", allowedPaths: [] })}>{c.add}</button><button type="button" className="ad-button" disabled={busy} onClick={() => void action(async () => { setRecords(await memoryCommands.list(GLOBAL_MEMORY_KEY)); setCollection({ id: "", name: "", recordIds: [] }); })}>{c.addCollection}</button></div>}
      {catalog && <SortableCollection surface="memory-collection-catalog" context="global" items={policy.memoryCollections} getId={item => item.id} getLabel={item => item.name} render={(item, handle) => <div>{handle}<button type="button" className="ad-button" disabled={busy} onClick={() => void action(async () => { setRecords(await memoryCommands.list(GLOBAL_MEMORY_KEY)); setCollection({ ...item, recordIds: [...item.recordIds] }); })}>{c.edit}: {item.name}</button></div>} />}
      <small>{c.revision}: {policy.revision} · {sessionId && policy.inheritProject ? c.inherit : c.delivered}</small>
      {(deliveredRevisions ?? (deliveredRevision === undefined ? [] : [deliveredRevision])).some(revision => revision !== policy.revision) && <p role="status" className="ad-source-context-warning">{c.old}</p>}
      {sessionId && <button type="button" className="ad-button" onClick={() => { onCorrectSources?.(); window.dispatchEvent(new CustomEvent("agentdeck-correct-sources", { detail: { sessionId } })); }}>{c.correct}</button>}
      <p className="ad-source-hint">{c.safety}</p>
      {catalog && policy.migrationBackup && <details><summary>{c.migration}</summary><code>{policy.migrationBackup}</code><p>{c.rollbackHint}</p><button type="button" className="ad-button" disabled={busy} onClick={() => void action(() => sourcePolicyCommands.rollbackMigration())}>{c.rollback}</button></details>}
    </>}
    {draft && <form className="ad-source-editor" onSubmit={event => { event.preventDefault(); void action(async () => { await sourcePolicyCommands.saveVault(draft); setDraft(null); }); }}>
      <label>{c.name}<input value={draft.name} required maxLength={200} disabled={busy} onChange={event => setDraft({ ...draft, name: event.target.value })} /></label>
      <label>{c.path}<input value={draft.path} required disabled={busy} onChange={event => setDraft({ ...draft, path: event.target.value })} /></label><button type="button" className="ad-button" disabled={busy} onClick={() => void action(async () => { const path = await knowledgeCommands.pickFolder(); if (path) setDraft({ ...draft, path, name: draft.name || path.split(/[\\/]/).filter(Boolean).slice(-1)[0] || "Vault" }); })}>{c.choose}</button>
      <label>{c.mode}<select value={draft.mode} disabled={busy} onChange={event => setDraft({ ...draft, mode: event.target.value as KnowledgeVault["mode"] })}><option value="disabled">{c.disabled}</option><option value="query">{c.query}</option><option value="automatic">{c.automatic}</option></select></label>
      <label>{c.restrictions}<textarea value={draft.allowedPaths.join("\n")} disabled={busy} onChange={event => setDraft({ ...draft, allowedPaths: event.target.value.split("\n") })} onBlur={() => setDraft({ ...draft, allowedPaths: draft.allowedPaths.map(path => path.trim()).filter(Boolean) })} /></label>
      <div className="ad-source-actions"><button type="submit" className="ad-button" disabled={busy || !draft.name.trim() || !draft.path.trim()}>{c.save}</button><button type="button" className="ad-button" disabled={busy} onClick={() => setDraft(null)}>{c.cancel}</button></div>
    </form>}
    {collection && <form className="ad-source-editor" onSubmit={event => { event.preventDefault(); void action(async () => { await sourcePolicyCommands.saveCollection(collection); setCollection(null); }); }}><label>{c.name}<input value={collection.name} required disabled={busy} onChange={event => setCollection({ ...collection, name: event.target.value })} /></label><p>{c.recordIds}</p>{!records.length && <p>{c.noRecords}</p>}<SortableCollection surface="memory-collection-records" context={collection.id || "new"} items={records} getId={record => record.id} getLabel={record => record.title} render={(record, handle) => <div>{handle}<label className="ad-source-checkbox"><input type="checkbox" checked={collection.recordIds.includes(record.id)} disabled={busy} onChange={event => setCollection({ ...collection, recordIds: event.target.checked ? [...collection.recordIds, record.id] : collection.recordIds.filter(id => id !== record.id) })} />{record.title}</label></div>} /><div className="ad-source-actions"><button type="submit" className="ad-button" disabled={busy || !collection.name.trim()}>{c.save}</button><button type="button" className="ad-button" disabled={busy} onClick={() => setCollection(null)}>{c.cancel}</button></div></form>}
  </section>;
}
