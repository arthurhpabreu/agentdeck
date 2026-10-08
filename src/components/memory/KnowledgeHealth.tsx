import { useEffect, useRef, useState } from "react";
import { useAppI18n } from "../../i18n";
import { knowledgeCommands, type KnowledgeHealth as Health } from "../../services/knowledgeCommands";
import { contextCopy } from "./contextCopy";
import "./contextSources.css";

export function KnowledgeHealth({ projectPath }: { projectPath?: string }) {
  const { locale } = useAppI18n(); const c = contextCopy(locale);
  const [health, setHealth] = useState<Health | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const request = useRef(0);
  const check = async (refresh = true) => {
    const version = ++request.current; setBusy(true); setError("");
    try {
      const result = await knowledgeCommands.health(projectPath, refresh);
      if (!result || !["none", "ready", "limited", "unavailable"].includes(result.status)) throw new Error(c.configuration);
      if (version === request.current) setHealth(result);
    } catch (cause) { if (version === request.current) setError(String(cause)); }
    finally { if (version === request.current) setBusy(false); }
  };
  useEffect(() => { void check(false); return () => { request.current++; }; }, [projectPath]);
  return <section className="ad-source-health" aria-label={c.health} aria-busy={busy}>
    <div><strong>{c.health}</strong><button type="button" className="ad-button" disabled={busy} onClick={() => void check()}>{busy ? c.checking : c.check}</button></div>
    {error && <p role="alert">{error}</p>}
    {health && <><p role={health.status === "unavailable" || health.status === "limited" ? "alert" : "status"}>{c[health.status]}{health.status === "ready" || health.status === "limited" ? ` · ${health.noteCount} ${c.notes}` : ""}</p>
      {health.status === "limited" && <p>{c.index_limited}</p>}
      <small>{c.checked}: {new Date(health.checkedAt).toLocaleString(locale)}</small>
      <small>{c.limits}: {health.maxNotes} {c.notes} · {health.maxIndexBytes / 1024 / 1024} {c.mib} · {health.maxNoteBytes / 1024} {c.kib} {c.perNote}</small>
    </>}
  </section>;
}
