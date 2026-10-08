import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { Pencil } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { useSessionStore, type ClaudeSession } from "../../store/sessionStore";
import "./sessionRename.css";

export function SessionRenameControl({ session, style }: { session: ClaudeSession; style?: CSSProperties }) {
  const { t } = useAppI18n();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(session.name);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const id = useId();
  const close = () => {
    dialog.current?.close();
    setOpen(false);
    trigger.current?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    element?.showModal();
    input.current?.focus();
    input.current?.select();
    return () => { if (element?.open) element.close(); };
  }, [open]);

  return <>
    <button type="button" ref={trigger} className="ad-session-rename-button" style={style}
      title={t("session.rename")} aria-label={t("session.rename")}
      onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}
      onClick={event => { event.stopPropagation(); setName(session.name); setOpen(true); }}><Pencil size={13} /></button>
    {open && createPortal(<dialog ref={dialog} className="ad-session-rename-dialog" aria-labelledby={`${id}-title`}
      onCancel={event => { event.preventDefault(); close(); }}
      onClick={event => event.stopPropagation()} onPointerDown={event => event.stopPropagation()}
      onKeyDown={event => event.stopPropagation()}>
      <form onSubmit={event => {
        event.preventDefault();
        if (useSessionStore.getState().renameSession(session.id, name)) close();
      }}>
        <h2 id={`${id}-title`}>{t("session.rename")}</h2>
        <label htmlFor={`${id}-name`}>{t("session.nameLabel")}</label>
        <input id={`${id}-name`} ref={input} value={name} maxLength={120} required
          aria-describedby={`${id}-hint`} onChange={event => setName(event.target.value)} />
        <p id={`${id}-hint`}>{t("session.renameHint")}</p>
        <div className="ad-session-rename-actions">
          <button type="button" className="ad-button" onClick={close}>{t("common.cancel")}</button>
          <button type="submit" className="ad-button ad-button-primary" disabled={!name.trim()}>{t("common.save")}</button>
        </div>
      </form>
    </dialog>, document.body)}
  </>;
}
