import { useId } from "react";
import { useAppI18n } from "../../i18n";
import { useSettingsStore } from "../../store/settingsStore";
import { sessionDirectoryCopy } from "./sessionDirectoryCopy";

export function SessionDirectoryControl({ disabled = false }: { disabled?: boolean }) {
  const { locale } = useAppI18n();
  const c = sessionDirectoryCopy(locale);
  const mode = useSettingsStore(state => state.settings.newSessionDirectoryMode);
  const patchSettings = useSettingsStore(state => state.patchSettings);
  const id = useId();
  return <div style={{ display: "grid", gap: 5, marginBottom: 10, minWidth: 0 }}>
    <label htmlFor={id} style={{ fontSize: 11, color: "var(--ci-text-muted)" }}>{c.label}</label>
    <select id={id} value={mode} disabled={disabled} aria-describedby={`${id}-hint`} onChange={event => patchSettings({ newSessionDirectoryMode: event.target.value === "worktree" ? "worktree" : "project" })} style={{ width: "100%", minWidth: 0, fontSize: 12, padding: "6px 8px", color: "var(--ci-text)", background: "var(--ci-bg)", border: "1px solid var(--ci-border)", borderRadius: 6 }}>
      <option value="project">{c.project}</option>
      <option value="worktree">{c.worktree}</option>
    </select>
    <p id={`${id}-hint`} style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: "var(--ci-text-dim)" }}>{mode === "worktree" ? c.worktreeHint : c.projectHint}</p>
  </div>;
}
