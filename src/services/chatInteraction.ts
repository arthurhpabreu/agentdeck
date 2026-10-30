export interface ChatQuestion {
  id: string; header: string; question: string; isSecret?: boolean;
  options?: { label: string; description: string }[] | null;
}
export interface ChatInteraction {
  id: string; kind: "approval" | "question"; blocking: boolean;
  command?: string; cwd?: string; reason?: string; grantRoot?: string; itemId?: string; action?: "command" | "fileChange" | "permissions" | "plan" | "tool" | "question"; questions?: ChatQuestion[];
  /** Tool name shown by Claude's own dialog. */
  title?: string;
  /** Claude offers "don't ask again" only when it suggests a rule; Codex always can. */
  canRemember?: boolean; provider?: "claude-code"; subagent?: boolean;
}
