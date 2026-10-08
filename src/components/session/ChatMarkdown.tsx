import { isValidElement, memo, useState, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Check, Copy } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { chatCopy } from "./chatCopy";

export function CopyButton({ text }: { text: string }) {
  const { locale } = useAppI18n(); const c = chatCopy(locale);
  const [copied, setCopied] = useState(false); const [failed, setFailed] = useState(false);
  return <button className="ad-icon-button" aria-label={copied ? c.copied : c.copy} title={failed ? c.retry : copied ? c.copied : c.copy} onClick={() => void navigator.clipboard.writeText(text).then(() => { setCopied(true); setFailed(false); setTimeout(() => setCopied(false), 1800); }).catch(() => setFailed(true))}>{copied ? <Check size={14} /> : <Copy size={14} />}</button>;
}
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  // Large generated outputs remain selectable/copyable without reparsing a giant AST per delta.
  if (text.length > 32_000) return <pre className="ad-large-message">{text}</pre>;
  return <div className="ad-markdown"><Markdown remarkPlugins={[remarkGfm]} components={{
    pre: ({ children }) => {
      const code = isValidElement<{ children?: ReactNode; className?: string }>(children) ? children.props : undefined;
      return <div className="ad-code-block"><div className="ad-code-header"><span>{code?.className?.replace("language-", "") || "code"}</span><CopyButton text={String(code?.children ?? "").replace(/\n$/, "")} /></div><pre>{children}</pre></div>;
    },
    code: ({ children, className }) => <code className={className}>{children}</code>,
    a: ({ href, children }) => <a href={href} onClick={e => { e.preventDefault(); if (href && /^https?:\/\//i.test(href)) void openUrl(href).catch(() => {}); }}>{children}</a>,
    img: ({ alt }) => <span className="ad-hint">[{alt || "image"}]</span>,
  }}>{text}</Markdown></div>;
});
