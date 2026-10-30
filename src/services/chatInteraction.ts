export interface ChatQuestion {
  id: string; header: string; question: string; isSecret?: boolean;
  options?: { label: string; description: string }[] | null;
}
export interface ChatInteraction {
  id: string; kind: "approval" | "question"; blocking: boolean;
  command?: string; cwd?: string; reason?: string; grantRoot?: string; itemId?: string; action?: "command" | "fileChange" | "permissions"; questions?: ChatQuestion[];
}
