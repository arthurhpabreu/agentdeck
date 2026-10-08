import { useId, useState } from "react";
import { FolderOpen } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAppI18n } from "../../i18n";
import { useWorkspaceStore, type WorkspaceColorId } from "../../store/workspaceStore";
import { WorkspaceColorPicker } from "./WorkspaceColorPicker";
import "./workspaceControls.css";

export function NewWorkspaceForm({ onDone }: { onDone: () => void }) {
  const { t, isRtl } = useAppI18n(); const id = useId();
  const [name, setName] = useState(""), [path, setPath] = useState(""), [error, setError] = useState("");
  const [color, setColor] = useState<WorkspaceColorId>("green"), [validColor, setValidColor] = useState(true), [operation, setOperation] = useState<"picking" | "saving" | null>(null);
  const busy = operation !== null;
  const pick = async () => { setOperation("picking"); setError(""); try { const picked = await invoke<string | null>("pick_folder"); if (picked) setPath(picked); } catch { setError(t("workspace.openFolderPickerFailed")); } finally { setOperation(null); } };
  const create = async () => {
    if (busy || !validColor) return;
    const trimmed = path.trim(); if (!trimmed) { setError(t("common.pathRequired")); return; }
    setOperation("saving");
    const workspaceId = useWorkspaceStore.getState().addWorkspace(trimmed, name.trim() || undefined, color);
    if ("__TAURI_INTERNALS__" in window) {
      await invoke("clear_deleted_items", { sessionIds: [], workspaceIds: [], sessionRefs: [], workspaceRefs: [{ workspaceId, path: trimmed }] }).catch(error => console.warn("[ui-state] clear deleted workspace failed:", error));
      void invoke("trust_workspace", { path: trimmed }).catch(() => {});
    }
    onDone();
  };
  return <form className="ad-workspace-form" aria-label={t("workspace.addWorkspace")} onSubmit={event => { event.preventDefault(); void create(); }}>
    <h3>{t("workspace.addWorkspace")}</h3>
    <label htmlFor={`${id}-name`}>{t("workspace.optionalName")}</label><input id={`${id}-name`} value={name} disabled={busy} onChange={event => setName(event.target.value)} dir={isRtl ? "rtl" : "ltr"} placeholder={t("workspace.defaultFolderName")} />
    <label htmlFor={`${id}-path`}>{t("workspace.directory")} <span aria-hidden="true">*</span></label><div className="ad-workspace-folder"><input id={`${id}-path`} value={path} disabled={busy} aria-required="true" aria-invalid={!!error} aria-describedby={error ? `${id}-error` : undefined} onChange={event => { setPath(event.target.value); setError(""); }} dir="ltr" placeholder={t("workspace.pathPlaceholder")} /><button type="button" className="ad-button" disabled={busy} onClick={() => void pick()}><FolderOpen size={15} />{operation === "picking" ? t("workspace.choosingDirectory") : t("workspace.chooseDirectory")}</button></div>
    {error && <p id={`${id}-error`} role="alert" className="ad-form-error">{error}</p>}
    <WorkspaceColorPicker value={color} onChange={setColor} onValidityChange={setValidColor} disabled={busy} />
    <div className="ad-form-actions"><button type="button" className="ad-button" disabled={busy} onClick={onDone}>{t("common.cancel")}</button><button type="submit" className="ad-button ad-button-primary" disabled={busy || !validColor}>{t(operation === "saving" ? "common.saving" : "common.create")}</button></div>
  </form>;
}
