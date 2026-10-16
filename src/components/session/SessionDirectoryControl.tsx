import { useId } from "react";
import { FolderGit2 } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { useSettingsStore } from "../../store/settingsStore";
import { sessionDirectoryCopy } from "./sessionDirectoryCopy";

/** `compact` keeps the remembered choice on one line; its explanation moves to the tooltip. */
export function SessionDirectoryControl({ disabled = false, compact = false }: { disabled?: boolean; compact?: boolean }) {
  const { locale } = useAppI18n();
  const c = sessionDirectoryCopy(locale);
  const mode = useSettingsStore(state => state.settings.newSessionDirectoryMode);
  const patchSettings = useSettingsStore(state => state.patchSettings);
  const id = useId();
  const hint = mode === "worktree" ? c.worktreeHint : c.projectHint;
  const options = <>
    <option value="project">{c.project}</option>
    <option value="worktree">{c.worktree}</option>
  </>;
  const change = (value: string) => patchSettings({ newSessionDirectoryMode: value === "worktree" ? "worktree" : "project" });
  if (compact) return <label className="ad-session-directory-compact" title={hint}>
    <FolderGit2 size={13} aria-hidden="true" />
    <select value={mode} disabled={disabled} aria-label={c.label} title={hint} onChange={event => change(event.target.value)}>{options}</select>
  </label>;
  return <div style={{ display: "grid", gap: 5, marginBottom: 10, minWidth: 0 }}>
    <label htmlFor={id} style={{ fontSize: 11, color: "var(--ci-text-muted)" }}>{c.label}</label>
    <select id={id} value={mode} disabled={disabled} aria-describedby={`${id}-hint`} onChange={event => change(event.target.value)} style={{ width: "100%", minWidth: 0, fontSize: 12, padding: "6px 8px", color: "var(--ci-text)", background: "var(--ci-bg)", border: "1px solid var(--ci-border)", borderRadius: 6 }}>
      {options}
    </select>
    <p id={`${id}-hint`} style={{ margin: 0, fontSize: 11, lineHeight: 1.5, color: "var(--ci-text-dim)" }}>{hint}</p>
  </div>;
}
