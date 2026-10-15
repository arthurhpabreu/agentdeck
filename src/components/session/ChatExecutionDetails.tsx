import { useAppI18n } from "../../i18n";
import { chatActivityCopy } from "./chatActivityCopy";
import "./chatActivity.css";

/** Passive provider logs stay inspectable without becoming chat alerts. */
export function ChatExecutionDetails({ diagnostic }: { diagnostic?: string }) {
  const { locale } = useAppI18n();
  if (!diagnostic?.trim()) return null;
  return <details className="ad-chat-execution-details">
    <summary>{chatActivityCopy(locale).details}</summary>
    <pre tabIndex={0}>{diagnostic}</pre>
  </details>;
}
