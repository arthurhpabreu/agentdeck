import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { getWorkspaceColor, normalizeWorkspaceColor, useWorkspaceStore, WORKSPACE_COLORS, type WorkspaceColorId } from "../../store/workspaceStore";
import "./workspaceControls.css";

export function WorkspaceColorPicker({ value, onChange, onValidityChange, disabled = false }: { value: WorkspaceColorId; onChange: (value: WorkspaceColorId) => void; onValidityChange: (valid: boolean) => void; disabled?: boolean }) {
  const { t } = useAppI18n(); const id = useId();
  const [hex, setHex] = useState(getWorkspaceColor(value));
  const valid = /^#[0-9a-f]{6}$/i.test(hex);
  useEffect(() => { setHex(getWorkspaceColor(value)); }, [value]);
  useEffect(() => { onValidityChange(valid); }, [valid, onValidityChange]);
  const choose = (color: WorkspaceColorId) => { setHex(getWorkspaceColor(color)); onChange(color); };
  return <fieldset className="ad-workspace-colors" disabled={disabled}><legend>{t("workspace.colorLabel")}</legend>
    <div className="ad-color-palette" role="group" aria-label={t("workspace.colorPresets")}>
      {WORKSPACE_COLORS.map(color => <button key={color.id} type="button" className="ad-color-swatch" aria-label={t(`colors.${color.id}`)} title={t(`colors.${color.id}`)} aria-pressed={getWorkspaceColor(value) === color.hex} style={{ "--swatch": color.hex } as React.CSSProperties} onClick={() => choose(color.id)}>{getWorkspaceColor(value) === color.hex && <Check size={14} aria-hidden="true" />}</button>)}
    </div>
    <div className="ad-color-custom"><label htmlFor={`${id}-picker`}>{t("workspace.customColor")}</label><div>
      <input id={`${id}-picker`} type="color" value={getWorkspaceColor(value)} onChange={event => choose(normalizeWorkspaceColor(event.target.value))} />
      <input aria-label={t("workspace.colorHex")} aria-invalid={!valid} aria-describedby={!valid ? `${id}-error` : undefined} dir="ltr" value={hex} maxLength={7} spellCheck={false} onChange={event => { const next = event.target.value; setHex(next); if (/^#[0-9a-f]{6}$/i.test(next)) onChange(normalizeWorkspaceColor(next)); }} />
      <span className="ad-color-preview" style={{ borderInlineStartColor: getWorkspaceColor(value) }}>{t("workspace.colorPreview")}</span>
    </div></div>
    {!valid && <p id={`${id}-error`} role="alert" className="ad-form-error">{t("workspace.colorInvalid")}</p>}
  </fieldset>;
}

export function WorkspaceColorControl({ workspaceId, name, value }: { workspaceId: string; name: string; value: WorkspaceColorId }) {
  const { t } = useAppI18n(); const [open, setOpen] = useState(false); const [draft, setDraft] = useState(value); const [valid, setValid] = useState(true);
  const trigger = useRef<HTMLButtonElement>(null), dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => { if (open) dialog.current?.showModal(); }, [open]);
  const close = () => { dialog.current?.close(); setOpen(false); trigger.current?.focus(); };
  return <>
    <button type="button" className="ad-workspace-color-trigger" ref={trigger} aria-label={t("workspace.editColor", { name })} title={t("workspace.editColor", { name })} onClick={event => { event.stopPropagation(); setDraft(value); setValid(true); setOpen(true); }}><i style={{ background: getWorkspaceColor(value) }} /></button>
    {open && createPortal(<dialog ref={dialog} className="ad-project-color-dialog" aria-label={t("workspace.editColor", { name })} onClick={event => event.stopPropagation()} onCancel={event => { event.preventDefault(); close(); }}>
      <h2>{t("workspace.editColor", { name })}</h2><WorkspaceColorPicker value={draft} onChange={setDraft} onValidityChange={setValid} />
      <div className="ad-form-actions"><button type="button" className="ad-button" onClick={close}>{t("common.cancel")}</button><button type="button" className="ad-button ad-button-primary" disabled={!valid} onClick={() => { useWorkspaceStore.getState().updateWorkspace(workspaceId, { color: draft }); close(); }}>{t("common.save")}</button></div>
    </dialog>, document.body)}
  </>;
}
