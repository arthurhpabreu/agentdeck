import type { CSSProperties } from "react";
import type { RunnerType } from "../store/settingsStore";

/** Small, theme-aware provider marks, kept in one place across chats and usage. */
export function ProviderIcon({ provider, size = 18, className, style }: {
  provider: RunnerType;
  size?: number;
  className?: string;
  style?: CSSProperties;
}) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className} style={{ flexShrink: 0, ...style }}>
    {provider === "claude-code" ? <g stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <path d="m12 2 .1 7.1M17 3.5l-3.5 6.2M21 7l-6.7 3.9M22 12l-7.2.1M20.5 17l-6.2-3.5M17 21l-3.9-6.7M12 22l-.1-7.2M7 20.5l3.5-6.2M3 17l6.7-3.9M2 12l7.2-.1M3.5 7l6.2 3.5M7 3l3.9 6.7" />
      <circle cx="12" cy="12" r="2.3" />
    </g> : provider === "codex" ? <g stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M15.1 4.5a4.7 4.7 0 0 0-8.6 1.2 4.7 4.7 0 0 0-3.3 7 4.7 4.7 0 0 0 3.6 6.7 4.7 4.7 0 0 0 8.7-1.2 4.7 4.7 0 0 0 3.3-7 4.7 4.7 0 0 0-3.7-6.7Z" />
      <path d="m15.1 4.5-5.3 3.1v6.1l5.3 3.1M6.5 5.7v6.1l5.3 3.1 5.3-3.1M3.2 12.7l5.3 3.1 5.3-3.1V6.6M6.8 19.4l5.4-3.1v-6.1L6.8 7.1M15.5 18.2v-6.1l-5.3-3.1-5.3 3.1M18.8 11.2l-5.3-3.1-5.3 3.1v6.1" />
    </g> : <path d="M12 2c1.5 6.1 3.9 8.5 10 10-6.1 1.5-8.5 3.9-10 10C10.5 15.9 8.1 13.5 2 12c6.1-1.5 8.5-3.9 10-10Z" fill="currentColor" />}
  </svg>;
}
