import { useAppI18n } from "../../i18n";
import type { KnowledgeWarning } from "../../services/knowledgeCommands";
import { contextCopy } from "./contextCopy";
import { KnowledgeLimitDetails } from "./KnowledgeLimitDetails";

export function KnowledgeWarnings({ warnings }: { warnings: KnowledgeWarning[] }) {
  const { locale } = useAppI18n(); const c = contextCopy(locale);
  if (!warnings.length) return null;
  return <div role="alert" className="ad-source-warning"><strong>{c.warning}</strong>{warnings.map((warning, index) => <div key={`${warning.scope}:${warning.sourcePath}:${index}`}>
    <p>{warning.scope === "global" ? c.global : warning.scope === "project" ? c.project : c.configuration}: {warning.code === "index_limited" ? c.limited : c[warning.code] ?? warning.message}</p>
    {warning.code === "index_limited" && <KnowledgeLimitDetails diagnostics={warning.diagnostics} />}
    <code>{warning.sourcePath}</code>
  </div>)}</div>;
}
