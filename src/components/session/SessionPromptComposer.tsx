import { ArrowUp, TerminalSquare } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { RUNNER_LABELS, type RunnerConfig, type RunnerType } from "../../store/settingsStore";
import { AgentModelPicker } from "./AgentModelPicker";
import { CommandTextarea } from "./CommandTextarea";

export function SessionPromptComposer({ workdir, pendingQuery, setPendingQuery, queryInputRef, runner, cliAvailable, cliCommand, installCmd, waitingForPtyLaunch, onSubmit, onLaunch, onRunnerChange, onRunnerPatch, onInstall, onRecheck, visible = true }: {
  pendingQuery: string; setPendingQuery: (value: string) => void; queryInputRef: React.RefObject<HTMLTextAreaElement | null>;
  workdir: string; runner: RunnerConfig; cliAvailable: boolean | null; cliCommand: string; installCmd?: string; waitingForPtyLaunch: boolean; visible?: boolean;
  onSubmit: (q: string) => void; onLaunch: () => void; onRunnerChange: (type: RunnerType) => void; onRunnerPatch: (patch: Partial<RunnerConfig>) => void; onInstall: () => void; onRecheck: () => void;
}) {
  const { t } = useAppI18n();
  const disabled = waitingForPtyLaunch || cliAvailable !== true;
  return <div className="ad-welcome" style={{ position: "absolute", inset: 0 }}>
    <div className="ad-welcome-inner">
      <header className="ad-welcome-head">
        <img src="/agentdeck-logo.jpg" alt="" width="44" height="44" />
        <div><h2>{t("session.promptTitle")}</h2><p>{t("chat.welcome")}</p></div>
      </header>
      <div className="ad-agent-pills" role="group" aria-label={t("agents.title")}>
        {(Object.entries(RUNNER_LABELS) as [RunnerType,string][]).map(([type,label]) => <button className="ad-button" key={type} disabled={waitingForPtyLaunch} aria-pressed={runner.type === type} onClick={() => onRunnerChange(type)}>{label}</button>)}
      </div>
      {waitingForPtyLaunch && <div className="ad-notice" role="status">{t("session.firstInstructionQueued")}</div>}
      {cliAvailable === false && <div className="ad-notice">
        <strong>{t("session.cliMissing", { command: cliCommand })}</strong><p><code>{installCmd}</code></p>
        <div style={{ display: "flex", gap: 8, marginTop: 8 }}><button className="ad-button" onClick={onInstall}>{t("common.installOneClick")}</button><button className="ad-button" onClick={onRecheck}>{t("common.refresh")}</button></div>
      </div>}
      <div className="ad-composer ad-composer-compact">
        <CommandTextarea shortcutsPlacement="above" visible={visible} inputRef={queryInputRef} runner={runner} workdir={workdir} native value={pendingQuery} onValueChange={setPendingQuery} rows={2} placeholder={t("session.promptPlaceholder")} aria-label={t("session.promptTitle")} disabled={waitingForPtyLaunch} onKeyDown={e => {
          if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); if (!disabled && pendingQuery.trim()) onSubmit(pendingQuery); }
        }} />
        <div className="ad-composer-footer">
          <AgentModelPicker compact workdir={workdir} runner={runner} onChange={onRunnerPatch} disabled={waitingForPtyLaunch} />
          <button className="ad-button ad-button-primary ad-chat-send" aria-label={t("chat.send")} title={t("chat.send")} disabled={disabled || !pendingQuery.trim()} onClick={() => onSubmit(pendingQuery)}><ArrowUp size={18} /></button>
        </div>
      </div>
      <div className="ad-welcome-foot">
        <span className="ad-hint" style={{ margin: 0, flex: 1 }}>{t("chat.keyboardHint")}</span>
        <button className="ad-button ad-button-ghost" disabled={disabled} onClick={onLaunch}><TerminalSquare size={15} />{t("chat.openAgent")}</button>
      </div>
      <p className="ad-hint">{t(`agents.auth.${runner.type}`)}</p>
    </div>
  </div>;
}
