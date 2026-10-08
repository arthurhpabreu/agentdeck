import { useEffect, useRef, useState } from "react";
import { ShieldCheck, Shield, LockKeyhole } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { getAgentAdapter } from "../../services/agentAdapters";
import type { RunnerConfig } from "../../store/settingsStore";
import { cachedAgentModels, loadAgentModels, executionOptions, type AgentModel } from "../../services/agentExecution";
import { AgentEffortControl } from "./AgentEffortControl";
import { modelCopy } from "./modelCopy";
import { AgentOptionsMenu } from "./AgentOptionsMenu";
import { useCliUpdateStore } from "../../store/cliUpdateStore";
import { workflowCopy } from "./workflowCopy";
import { composerCopy } from "./composerCopy";

export function AgentModelPicker({ runner, onChange, disabled = false, workdir = "", compact = false }: { runner: RunnerConfig; onChange: (patch: Partial<RunnerConfig>) => void; disabled?: boolean; workdir?: string; compact?: boolean }) {
  const { t, locale } = useAppI18n(); const c = modelCopy(locale);
  const w = workflowCopy(locale);
  const composer = composerCopy(locale);
  const adapter = getAgentAdapter(runner.type);
  const [models, setModels] = useState<AgentModel[]>(adapter.models);
  const [custom, setCustom] = useState(false);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const generation = useRef(0);
  const catalogueRevision = useCliUpdateStore(state => state.revision);
  const refresh = async (force = false) => {
    const token = ++generation.current;
    setLoading(true); setError("");
    try {
      const items = await loadAgentModels(runner.type, runner.cliPath, force, workdir);
      if (token === generation.current) { setModels(items.length ? items : adapter.models); if (runner.type !== "gemini" && !items.length) setError(c.unavailable); }
    } catch { if (token === generation.current) setError(c.unavailable); }
    finally { if (token === generation.current) setLoading(false); }
  };
  useEffect(() => {
    setCustom(false);
    const cached = cachedAgentModels(runner.type, runner.cliPath, workdir);
    setModels(cached?.length ? cached : adapter.models);
    if (!("__TAURI_INTERNALS__" in window)) return;
    void refresh();
    return () => { generation.current++; };
  }, [runner.type, runner.cliPath, workdir, adapter, catalogueRevision]);
  const unknown = !!runner.model && !models.some(m => m.id === runner.model);
  const changeModel = (model: string) => onChange({ model, ...executionOptions({ ...runner, model }, workdir) });
  const selected = models.find(model => model.id === (runner.model || "default") || !!runner.model && model.resolvedModel === runner.model);
  const defaultModel = models.find(model => model.id === "default");
  const defaultName = defaultModel?.resolvedModel ? models.find(model => model.id !== "default" && model.resolvedModel === defaultModel.resolvedModel)?.label || defaultModel.resolvedModel : undefined;
  const modelTitle = `${selected?.resolvedModel ? `${c.version}: ${selected.resolvedModel}` : t("chat.modelHint")}${selected?.cliVersion ? ` · ${c.cli}: ${selected.cliVersion}` : ""}`;
  const fullAccess = runner.fullAccess !== false;
  const readOnly = runner.mode === "plan";
  return <div className={`ad-agent-controls${compact ? " is-compact" : ""}`}>
    {compact && <button type="button" role="switch" aria-label={w.fullAccess} aria-checked={fullAccess} disabled={disabled || readOnly} className="ad-full-access ad-access-control" data-enabled={fullAccess && !readOnly} title={`${readOnly ? composer.readOnly : fullAccess ? composer.fullAccess : composer.cliPermissions} · ${readOnly ? w.planAccess : w.fullHint}`} onClick={() => onChange({ fullAccess: !fullAccess })}>
      {readOnly ? <LockKeyhole size={14} /> : fullAccess ? <ShieldCheck size={14} /> : <Shield size={14} />}
      <span>{readOnly ? composer.readOnly : fullAccess ? composer.fullAccess : composer.cliPermissions}</span>
    </button>}
    <label className="ad-field ad-model-field"><span className="ad-control-label">{t("chat.model")}</span>
      <select aria-label={t("chat.model")} title={modelTitle} disabled={disabled || loading} value={custom || unknown ? "__custom" : runner.model === "default" ? "" : runner.model ?? ""} onChange={e => {
        const value = e.target.value; setCustom(value === "__custom"); if (value !== "__custom") changeModel(value);
      }}>
        <option value="">{defaultName ? `${defaultName} (${c.default})` : t("chat.defaultModel")}</option>
        {models.filter(model => model.id !== "default").map(model => <option key={model.id} value={model.id}>{model.label}{runner.type === "claude-code" && !model.resolvedModel ? ` · ${c.unverified}` : ""}</option>)}
        <option value="__custom">{t("chat.customModel")}</option>
      </select>
    </label>
    {(custom || unknown) && <label className="ad-field ad-custom-model-field"><span className="ad-control-label">{t("chat.modelId")}</span><input aria-label={t("chat.modelId")} disabled={disabled} value={runner.model ?? ""} onChange={e => changeModel(e.target.value)} placeholder={t("chat.modelIdPlaceholder")} /></label>}
    <AgentEffortControl runner={runner} workdir={workdir} onChange={onChange} disabled={disabled} compact={compact} />
    <label className="ad-field ad-mode-field"><span className="ad-control-label">{t("chat.mode")}</span>
      <select aria-label={t("chat.mode")} title={`${t("chat.mode")}: ${readOnly ? c.plan : c.execute}`} disabled={disabled} value={runner.mode ?? "default"} onChange={e => onChange({ mode: e.target.value as "default" | "plan" })}>
        <option value="default">{c.execute}</option><option value="plan">{c.plan}</option>
      </select>
    </label>
    <AgentOptionsMenu key={`${runner.type}:${workdir}`} runner={runner} model={selected} loading={loading} disabled={disabled} error={error} onRefresh={() => void refresh(true)} />
    {!compact && <label className="ad-full-access" title={readOnly ? w.planAccess : w.fullHint}><input type="checkbox" role="switch" aria-label={w.fullAccess} checked={fullAccess} disabled={disabled || readOnly} onChange={e => onChange({ fullAccess: e.target.checked })} />{w.fullAccess}</label>}
    {error && <span className="ad-catalogue-error" role="status">{c.unavailableShort}</span>}
  </div>;
}
