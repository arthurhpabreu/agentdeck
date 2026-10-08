import { ChevronDown, Folder, Globe } from "lucide-react";
import { useWorkspaceStore } from "../../store/workspaceStore";

interface Labels { scope: string; global: string; project: string; globalHint: string; projectHint: string; projectLabel: string; noProject: string }
export function KnowledgeScopeControls({ scope, onChange, labels, disabled = false }: {
  scope: "global" | "project"; onChange: (scope: "global" | "project") => void; labels: Labels; disabled?: boolean;
}) {
  const { workspaces, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore();
  return <>
    <div className="ad-memory-scopes" role="group" aria-label={labels.scope}>
      <button type="button" aria-pressed={scope === "global"} disabled={disabled} onClick={() => onChange("global")}><Globe size={14} />{labels.global}</button>
      <button type="button" aria-pressed={scope === "project"} disabled={disabled} onClick={() => onChange("project")}><Folder size={14} />{labels.project}</button>
    </div>
    <p className="ad-memory-scope-hint">{scope === "global" ? labels.globalHint : labels.projectHint}</p>
    {scope === "project" && workspaces.length > 0 && <label className="ad-memory-project"><Folder size={14} /><select aria-label={labels.projectLabel} disabled={disabled} value={activeWorkspaceId ?? ""} onChange={event => setActiveWorkspace(event.target.value)}>
      {!activeWorkspaceId && <option value="">{labels.noProject}</option>}
      {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
    </select><ChevronDown size={12} /></label>}
  </>;
}
