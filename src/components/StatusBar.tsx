import { useAppI18n } from "../i18n";
import { ClaudeSession, SessionStatus } from "../store/sessionStore";
import { useChatStore } from "../store/chatStore";
import { useSettingsStore, isGlassTheme } from "../store/settingsStore";

const STATUS_LABEL_KEY: Record<SessionStatus, string> = {
  idle: "status.idle",
  running: "status.running",
  waiting: "status.waiting",
  suspended: "status.suspended",
  done: "status.done",
  error: "status.error",
};

const STATUS_COLOR: Record<SessionStatus, string> = {
  idle: "var(--ci-text-muted)",
  running: "#34C759",
  waiting: "#FF9F0A",
  suspended: "#6B7280",
  done: "#007AFF",
  error: "#FF3B30",
};

export function StatusBar({ session }: { session?: ClaudeSession }) {
  const { t } = useAppI18n();
  const runtimeStatus = useChatStore(state => {
    const thread = session ? state.threads[session.id] : undefined;
    return thread?.busy ? thread.interactions?.find(request => request.blocking)?.kind ?? "running" : session?.status ?? "idle";
  });
  const status: SessionStatus = runtimeStatus === "approval" || runtimeStatus === "question" ? "waiting" : runtimeStatus;
  const labelKey = runtimeStatus === "approval" ? "workspace.attentionApproval" : runtimeStatus === "question" ? "workspace.attentionQuestion" : STATUS_LABEL_KEY[status];
  const isGlass = useSettingsStore((s) => isGlassTheme(s.settings.theme));
  const textShadow = isGlass ? "var(--ci-glass-text-shadow)" : "none";

  return (
    <div
      style={{
        padding: "10px 18px 12px",
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        borderTop: isGlass || !session ? "none" : "1px solid var(--ci-toolbar-border)",
        background: isGlass ? "var(--ci-status-bg)" : "transparent",
        textShadow,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        {session ? (
          <>
            <span
              style={{
                width: 6,
                height: 6,
                borderRadius: "50%",
                flexShrink: 0,
                background: STATUS_COLOR[status],
              }}
            />
            <span style={{ fontSize: 10, color: STATUS_COLOR[status], flexShrink: 0, fontWeight: 600 }}>
              {t(labelKey)}
            </span>
            <span style={{ fontSize: 10, color: "var(--ci-text-dim)", flexShrink: 0, opacity: 0.45 }}>·</span>
            <span
              style={{
                fontSize: 10,
                color: "var(--ci-text-dim)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
                fontFamily: "Cascadia Code, Consolas, monospace",
                minWidth: 0,
              }}
            >
              {session.workdir}
            </span>
          </>
        ) : (
          <span style={{ fontSize: 10, color: "var(--ci-text-dim)" }}>{t("status.noActiveSession")}</span>
        )}
      </div>
    </div>
  );
}
