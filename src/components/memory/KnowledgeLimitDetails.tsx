import { useAppI18n } from "../../i18n";
import type { KnowledgeDiagnostics } from "../../services/knowledgeCommands";
import { contextCopy } from "./contextCopy";

const messages = {
  notes: ["Limite de {limit} notas atingido. Selecione uma subpasta para incluir outras notas.", "The {limit}-note limit was reached. Select a subfolder to include other notes.", "Se alcanzó el límite de {limit} notas. Selecciona una subcarpeta para incluir otras notas."],
  bytes: ["Limite total de {limit} MiB atingido. Selecione uma pasta menor.", "The total limit of {limit} MiB was reached. Select a smaller folder.", "Se alcanzó el límite total de {limit} MiB. Selecciona una carpeta más pequeña."],
  truncated: ["Notas com texto truncado: {count} (limite de {limit} MiB por nota). Divida as notas maiores para indexar todo o texto.", "Notes with truncated text: {count} (limit of {limit} MiB per note). Split larger notes to index their full text.", "Notas con texto truncado: {count} (límite de {limit} MiB por nota). Divide las notas grandes para indexar todo el texto."],
  files: ["Arquivos que não puderam ser lidos: {count}. Verifique as permissões e a sincronização da pasta.", "Files that could not be read: {count}. Check permissions and folder sync.", "Archivos que no pudieron leerse: {count}. Comprueba los permisos y la sincronización de la carpeta."],
  folders: ["Pastas que não puderam ser lidas: {count}. Verifique as permissões de acesso.", "Folders that could not be read: {count}. Check access permissions.", "Carpetas que no pudieron leerse: {count}. Comprueba los permisos de acceso."],
  depth: ["Há pastas além de {limit} níveis de profundidade. Selecione uma subpasta como fonte.", "Some folders exceed {limit} levels of depth. Select a subfolder as the source.", "Hay carpetas con más de {limit} niveles de profundidad. Selecciona una subcarpeta como fuente."],
} as const;

export function KnowledgeLimitDetails({ diagnostics }: { diagnostics?: KnowledgeDiagnostics | null }) {
  const { locale } = useAppI18n(); const c = contextCopy(locale);
  const index = locale.startsWith("pt") ? 0 : locale.startsWith("es") ? 2 : 1;
  const reasons: string[] = [];
  const add = (key: keyof typeof messages, count = 0, limit = 0) => reasons.push(messages[key][index].replace("{count}", count.toLocaleString(locale)).replace("{limit}", limit.toLocaleString(locale)));
  if (diagnostics) {
    const d = diagnostics;
    if (d.noteLimitReached) add("notes", 0, d.maxNotes);
    if (d.indexByteLimitReached) add("bytes", 0, d.maxIndexBytes / 1024 / 1024);
    if (d.truncatedNoteCount) add("truncated", d.truncatedNoteCount, d.maxNoteBytes / 1024 / 1024);
    if (d.unreadableFileCount) add("files", d.unreadableFileCount);
    if (d.unreadableDirectoryCount) add("folders", d.unreadableDirectoryCount);
    if (d.depthLimitReached) add("depth", 0, d.maxDepth);
  }
  return reasons.length ? <ul className="ad-source-limit-details">{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul> : <p>{c.index_limited}</p>;
}
