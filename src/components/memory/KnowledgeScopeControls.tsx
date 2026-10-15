import { ChevronDown, Folder, Globe } from "lucide-react";
import { useWorkspaceStore } from "../../store/workspaceStore";

interface Labels { scope: string; global: string; project: string; globalHint: string; projectHint: string; projectLabel: string; noProject: string }
export function KnowledgeScopeControls({ scope, onChange, labels, disabled = false, projectId, locked = false, projectFirst = false }: {
  scope: "global" | "project"; onChange: (scope: "global" | "project") => void; labels: Labels; disabled?: boolean; projectId?: string; locked?: boolean; projectFirst?: boolean;
}) {
  const { workspaces, activeWorkspaceId, setActiveWorkspace } = useWorkspaceStore();
  return <>
    <div className="ad-memory-scopes" role="group" aria-label={labels.scope}>
      {(projectFirst ? ["project", "global"] : ["global", "project"]).map(value => <button key={value} type="button" aria-pressed={scope === value} disabled={disabled} onClick={() => onChange(value as "global" | "project")}>{value === "global" ? <Globe size={14} /> : <Folder size={14} />}{value === "global" ? labels.global : labels.project}</button>)}
    </div>
    <p className="ad-memory-scope-hint">{scope === "global" ? labels.globalHint : labels.projectHint}</p>
    {scope === "project" && workspaces.length > 0 && <label className="ad-memory-project"><Folder size={14} /><select aria-label={labels.projectLabel} disabled={disabled || locked} value={projectId ?? activeWorkspaceId ?? ""} onChange={event => setActiveWorkspace(event.target.value)}>
      {!activeWorkspaceId && <option value="">{labels.noProject}</option>}
      {workspaces.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
    </select><ChevronDown size={12} /></label>}
  </>;
}
