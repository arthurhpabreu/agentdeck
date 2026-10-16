import { useEffect, useMemo, useState } from "react";
import { ATTENTION_RANK, useAttentionStore, type AttentionItem, type AttentionKind } from "../store/attentionStore";
import { useChatStore } from "../store/chatStore";
import { selectSessionNavigation, useSessionStore, type ClaudeSession } from "../store/sessionStore";

/** Translation keys naming the most urgent unread event. */
export const ATTENTION_LABEL: Record<AttentionKind, string> = {
  approval: "workspace.attentionApproval",
  question: "workspace.attentionQuestion",
  error: "workspace.attentionError",
  completed: "workspace.attentionCompleted",
};

export interface SessionActivity {
  /** Last real agent or user activity: creation, latest message or attention event. */
  at: number;
  /** Most urgent unread event. */
  attention?: AttentionKind;
  unread: number;
}

/** Combine sessions, conversations and attention events for navigation. */
export function sessionActivity(sessions: ClaudeSession[], items: AttentionItem[]): Map<string, SessionActivity> {
  // Read conversations without subscribing navigation to streaming output.
  const threads = useChatStore.getState().threads;
  const result = new Map<string, SessionActivity>(sessions.map(session => {
    const messages = threads[session.id]?.messages;
    return [session.id, { at: Math.max(session.createdAt, messages?.[messages.length - 1]?.at ?? 0), unread: 0 }];
  }));
  for (const item of items) {
    const activity = result.get(item.sessionId);
    if (!activity) continue;
    activity.at = Math.max(activity.at, item.at);
    if (item.read) continue;
    activity.unread += 1;
    if (!activity.attention || ATTENTION_RANK[item.kind] < ATTENTION_RANK[activity.attention]) activity.attention = item.kind;
  }
  return result;
}

/** Status changes and attention events refresh activity; a timer keeps relative times current. */
export function useSessionActivity() {
  const sessions = useSessionStore(selectSessionNavigation);
  const items = useAttentionStore(state => state.items);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 5 * 60 * 1000);
    return () => clearInterval(timer);
  }, []);
  // `now` also rereads conversations that changed since the last status update.
  const activity = useMemo(() => sessionActivity(sessions, items), [sessions, items, now]);
  return { sessions, activity, now };
}
