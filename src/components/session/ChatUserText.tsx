import { useState } from "react";
import { useAppI18n } from "../../i18n";
export function ChatUserText({ text }: { text: string }) {
  const { locale } = useAppI18n(); const [expanded, setExpanded] = useState(false);
  const large = text.length > 16000;
  const more = locale.startsWith("pt") ? "Ler mensagem completa" : locale.startsWith("es") ? "Leer mensaje completo" : "Read complete message";
  const less = locale.startsWith("pt") ? "Recolher mensagem" : locale.startsWith("es") ? "Contraer mensaje" : "Collapse message";
  return <><p className="ad-user-text" style={large && expanded ? { maxHeight:320, overflow:"auto" } : undefined}>{large && !expanded ? text.slice(0, 1600) + "…" : text}</p>{large && <button type="button" className="ad-button ad-button-ghost" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? less : more}</button>}</>;
}
