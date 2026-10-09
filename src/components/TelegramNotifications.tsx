import { useEffect, useId, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Send } from "lucide-react";
import { useAppI18n } from "../i18n";

interface TelegramSettings {
  enabled: boolean;
  configured: boolean;
  botUsername: string | null;
  chatLabel: string | null;
  lastError: string | null;
}

interface TelegramPairing {
  pairingId: string;
  url: string;
  botUsername: string;
}

type Action = "load" | "connect" | "confirm" | "toggle" | "test" | "disconnect" | "open";

const errorCodes = new Set([
  "invalidToken", "unauthorized", "network", "timeout", "api", "forbidden",
  "rateLimited", "conflict", "webhookConfigured", "invalidResponse", "responseTooLarge",
  "pairingExpired", "pairingNotFound", "pairingBusy", "notConfigured", "storage",
  "secureStorage", "disabled", "internal", "openLink",
]);

function safeErrorKey(error: unknown): string {
  if (typeof error === "string" && error.startsWith("telegram.errors.") &&
      errorCodes.has(error.slice("telegram.errors.".length))) return error;
  return "telegram.errors.internal";
}

function requireSettings(value: TelegramSettings | null): TelegramSettings {
  if (!value || typeof value.enabled !== "boolean" || typeof value.configured !== "boolean") {
    throw "telegram.errors.invalidResponse";
  }
  return value;
}

const C = {
  text: "var(--ci-text)",
  textMuted: "var(--ci-text-muted)",
  textDim: "var(--ci-text-dim)",
  accent: "var(--ci-accent)",
  border: "var(--ci-border)",
  red: "var(--ci-red)",
};

const actionsStyle = { display: "flex", flexWrap: "wrap", gap: 8 } as const;
const hintStyle = { fontSize: 12, color: C.textMuted, lineHeight: 1.6, margin: 0 } as const;

export function TelegramNotifications({ notificationsEnabled }: { notificationsEnabled: boolean }) {
  const { t } = useAppI18n();
  const id = useId();
  const desktop = typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
  const [settings, setSettings] = useState<TelegramSettings | null>(null);
  const [busy, setBusy] = useState<Action | null>(desktop ? "load" : null);
  const [token, setToken] = useState("");
  const [pairing, setPairing] = useState<TelegramPairing | null>(null);
  const [reconnecting, setReconnecting] = useState(false);
  const [error, setError] = useState("");
  const [feedback, setFeedback] = useState("");
  const disabled = !!busy || !desktop;
  const showSetup = !settings?.configured || reconnecting;
  const displayError = error || (settings?.lastError ? safeErrorKey(settings.lastError) : "");

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void invoke<TelegramSettings | null>("get_telegram_notification_settings").then(value => {
      const result = requireSettings(value);
      if (active) setSettings(result);
    }).catch(reason => {
      if (active) setError(safeErrorKey(reason));
    }).finally(() => {
      if (active) setBusy(null);
    });
    return () => { active = false; };
  }, [desktop]);

  async function act(action: Action, operation: () => Promise<void>) {
    if (disabled) return;
    setBusy(action);
    setError("");
    setFeedback("");
    try {
      await operation();
    } catch (reason) {
      setError(safeErrorKey(reason));
    } finally {
      setBusy(null);
    }
  }

  async function openTelegram(url: string) {
    if (!/^https:\/\/t\.me\/[A-Za-z0-9_]+(?:\?start=[A-Za-z0-9_-]+)?$/.test(url)) {
      throw "telegram.errors.openLink";
    }
    try {
      if (desktop) await openUrl(url);
      else window.open(url, "_blank", "noopener,noreferrer");
    } catch {
      throw "telegram.errors.openLink";
    }
  }

  function openLink(url: string) {
    if (desktop) void act("open", () => openTelegram(url));
    else void openTelegram(url).catch(() => setError("telegram.errors.openLink"));
  }

  return (
    <section
      aria-labelledby={`${id}-title`}
      aria-busy={!!busy}
      style={{ marginTop: 12, padding: 14, border: `1px solid ${C.border}`, borderRadius: 14, display: "grid", gap: 12 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Send size={16} aria-hidden="true" style={{ color: C.accent, flexShrink: 0 }} />
        <h3 id={`${id}-title`} style={{ fontSize: 14, fontWeight: 600, color: C.text, margin: 0 }}>{t("telegram.title")}</h3>
      </div>
      <p style={hintStyle}>{t("telegram.description")}</p>
      {!desktop && <p style={hintStyle}>{t("telegram.desktopOnly")}</p>}
      {busy === "load" && <p role="status" style={hintStyle}>{t("common.loading")}</p>}

      {settings?.configured && (
        <div style={{ display: "grid", gap: 4, minWidth: 0 }}>
          <strong style={{ fontSize: 12, color: C.text, overflowWrap: "anywhere" }}>
            {t("telegram.connectedTo", { bot: settings.botUsername ? `@${settings.botUsername}` : t("telegram.title") })}
          </strong>
          {settings.chatLabel && <span style={{ fontSize: 11, color: C.textDim, overflowWrap: "anywhere" }}>{settings.chatLabel}</span>}
        </div>
      )}

      {showSetup && !pairing && busy !== "load" && (settings || !desktop) && (
        <form
          onSubmit={event => {
            event.preventDefault();
            void act("connect", async () => {
              const result = await invoke<TelegramPairing>("start_telegram_pairing", { token: token.trim() });
              setToken("");
              setPairing(result);
            });
          }}
          style={{ display: "grid", gap: 10 }}
        >
          <p style={hintStyle}>{t(reconnecting ? "telegram.reconnectHint" : "telegram.createBotHint")}</p>
          {!reconnecting && <div style={actionsStyle}>
            <button type="button" className="ad-button" disabled={!!busy} onClick={() => openLink("https://t.me/BotFather")}>{t("telegram.openBotFather")}</button>
          </div>}
          <div style={{ display: "grid", gap: 6 }}>
            <label htmlFor={`${id}-token`} style={{ color: C.text, fontSize: 12, fontWeight: 600 }}>{t("telegram.tokenLabel")}</label>
            <input
              id={`${id}-token`}
              type="password"
              value={token}
              onChange={event => setToken(event.currentTarget.value)}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              disabled={disabled}
              required={!settings?.configured}
              aria-describedby={`${id}-token-hint`}
              placeholder={t(reconnecting ? "telegram.savedTokenPlaceholder" : "telegram.tokenPlaceholder")}
              dir="ltr"
              style={{ width: "100%", minWidth: 0, boxSizing: "border-box", padding: "9px 10px", background: "var(--ci-surface)", border: `1px solid ${C.border}`, borderRadius: 8, color: C.text, font: "inherit", fontSize: 12 }}
            />
            <small id={`${id}-token-hint`} style={{ color: C.textDim, fontSize: 11, lineHeight: 1.6 }}>{t("telegram.tokenHint")}</small>
          </div>
          <div style={actionsStyle}>
            <button type="submit" className="ad-button ad-button-primary" disabled={disabled || (!settings?.configured && !token.trim())}>
              {t(busy === "connect" ? "telegram.connecting" : "telegram.connect")}
            </button>
            {reconnecting && <button type="button" className="ad-button" disabled={disabled} onClick={() => { setReconnecting(false); setToken(""); setError(""); }}>{t("common.cancel")}</button>}
          </div>
        </form>
      )}

      {pairing && (
        <div style={{ display: "grid", gap: 10 }}>
          <p style={hintStyle}>{t("telegram.startHint", { bot: `@${pairing.botUsername}` })}</p>
          <div style={actionsStyle}>
            <button type="button" className="ad-button ad-button-primary" disabled={disabled} onClick={() => openLink(pairing.url)}>{t("telegram.openBot")}</button>
            <button type="button" className="ad-button" disabled={disabled} onClick={() => void act("confirm", async () => {
              setSettings(requireSettings(await invoke<TelegramSettings>("finish_telegram_pairing", { pairingId: pairing.pairingId })));
              setPairing(null);
              setReconnecting(false);
              setFeedback("telegram.paired");
            })}>{t(busy === "confirm" ? "telegram.confirming" : "telegram.confirmStarted")}</button>
            <button type="button" className="ad-button ad-button-ghost" disabled={disabled} onClick={() => { setPairing(null); setToken(""); setError(""); }}>{t("common.cancel")}</button>
          </div>
        </div>
      )}

      <div className="ad-memory-setting" style={{ padding: "4px 0", opacity: !settings?.configured || !notificationsEnabled ? .56 : 1 }}>
        <label htmlFor={`${id}-enabled`}>
          <strong id={`${id}-enabled-label`}>{t("telegram.enabledLabel")}</strong>
          <small id={`${id}-enabled-hint`}>{t(!notificationsEnabled ? "telegram.masterDisabled" : "telegram.enabledHint")}</small>
        </label>
        <button
          id={`${id}-enabled`}
          type="button"
          role="switch"
          className="ad-memory-switch"
          aria-checked={settings?.enabled ?? false}
          aria-labelledby={`${id}-enabled-label`}
          aria-describedby={`${id}-enabled-hint`}
          disabled={disabled || !settings?.configured || !notificationsEnabled || !!pairing}
          onClick={() => void act("toggle", async () => {
            setSettings(requireSettings(await invoke<TelegramSettings>("set_telegram_notifications_enabled", { enabled: !settings?.enabled })));
          })}
        ><span /></button>
      </div>

      {settings?.configured && !showSetup && !pairing && (
        <div style={actionsStyle}>
          <button type="button" className="ad-button" disabled={disabled} onClick={() => void act("test", async () => {
            await invoke<void>("send_telegram_test");
            setFeedback("telegram.testSent");
            setSettings(current => current ? { ...current, lastError: null } : current);
          })}>{t(busy === "test" ? "telegram.sendingTest" : "telegram.sendTest")}</button>
          <button type="button" className="ad-button" disabled={disabled} onClick={() => { setReconnecting(true); setToken(""); setError(""); setFeedback(""); }}>{t("telegram.reconnect")}</button>
          <button type="button" className="ad-button ad-button-ghost" disabled={disabled} onClick={() => void act("disconnect", async () => {
            const result = requireSettings(await invoke<TelegramSettings>("disconnect_telegram_notifications"));
            setSettings(result);
            if (!result.configured && !result.lastError) {
              setToken("");
              setPairing(null);
              setReconnecting(false);
              setFeedback("telegram.disconnected");
            }
          })}>{t(busy === "disconnect" ? "telegram.disconnecting" : "telegram.disconnect")}</button>
        </div>
      )}

      {displayError && <p role="alert" style={{ ...hintStyle, color: C.red }}>{t(displayError)}</p>}
      {desktop && !settings && !busy && <div style={actionsStyle}><button type="button" className="ad-button" onClick={() => void act("load", async () => {
        setSettings(requireSettings(await invoke<TelegramSettings>("get_telegram_notification_settings")));
      })}>{t("common.refresh")}</button></div>}
      {feedback && <p role="status" style={{ ...hintStyle, color: C.accent }}>{t(feedback)}</p>}
      <small style={{ color: C.textDim, fontSize: 11, lineHeight: 1.6 }}>{t("telegram.deliveryHint")}</small>
    </section>
  );
}
