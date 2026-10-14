import { useEffect, useRef, useState } from "react";
import { Bell, X } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { useAttentionStore } from "../../store/attentionStore";
import { selectSessionNavigation, useSessionStore } from "../../store/sessionStore";
import { showSessionSurface } from "../../services/workbenchCommands";
import { improvementsCopy } from "../platformImprovementsCopy";
import "./needsYou.css";
import { SortableCollection } from "../ordering/SortableCollection";

export function NeedsYou() {
  const { locale } = useAppI18n(); const c = improvementsCopy(locale);
  const items = useAttentionStore(state => state.items);
  const sessions = useSessionStore(selectSessionNavigation);
  const [open, setOpen] = useState(false); const dialog = useRef<HTMLDialogElement>(null); const trigger = useRef<HTMLButtonElement>(null);
  const unread = items.filter(item => !item.read && sessions.some(session => session.id === item.sessionId));
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close(); }, [open]);
  const close = () => { setOpen(false); trigger.current?.focus(); };
  return <><button ref={trigger} className="ad-button ad-button-ghost" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}><Bell size={16}/>{c.attention}{unread.length > 0 && <b>{unread.length}</b>}</button>
    <dialog ref={dialog} className="ad-needs-you" aria-label={c.attention} onCancel={event => { event.preventDefault(); close(); }}>
      <header><h2>{c.attention}</h2><button className="ad-icon-button" aria-label={c.close} onClick={close}><X size={18}/></button></header>
      {!unread.length && <p>{c.empty}</p>}
      <SortableCollection surface="needs-you" context="inbox" items={unread} allIds={items.map(item => item.id)} getId={item => item.id} getLabel={item => sessions.find(session => session.id === item.sessionId)?.name ?? item.sessionId} render={(item, handle) => <article data-attention-id={item.id}>{handle}<button className="ad-attention-link" onClick={() => { useAttentionStore.getState().readSession(item.sessionId); close(); showSessionSurface(item.sessionId); }}><strong>{sessions.find(session => session.id === item.sessionId)?.name}</strong><span>{c[item.kind]} · {item.source} · {new Date(item.at).toLocaleTimeString(locale)}</span>{item.text && <p>{item.text}</p>}</button><button className="ad-button ad-button-ghost" onClick={() => useAttentionStore.getState().read(item.id)}>{c.read}</button></article>}/>
    </dialog></>;
}
