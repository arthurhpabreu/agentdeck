const active = new Set(["running", "in_progress", "inProgress", "started", "pending", "queued"]);
const terminal = new Set(["completed", "success", "failed", "error", "stopped", "interrupted", "cancelled"]);

export function isPendingChatTool(status: string | undefined): boolean {
  return status === undefined || active.has(status);
}

export function isTerminalChatTool(status: string | undefined): boolean {
  return status !== undefined && terminal.has(status);
}

/** A progress replay cannot reopen the same provider tool call after its result. */
export function mergeChatToolStatus(previous: string | undefined, incoming: string | undefined): string | undefined {
  return isTerminalChatTool(previous) && isPendingChatTool(incoming) ? previous : incoming ?? previous;
}
