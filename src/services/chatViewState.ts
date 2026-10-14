import type { ChatAttachment, ChatMessage } from "../store/chatStore";
export interface PendingChatAttachment extends ChatAttachment { preview?: string }
export interface ChatViewState { attachments: PendingChatAttachment[]; scrollTop: number; follow: boolean; selectionStart: number; selectionEnd: number; historyPage?: ChatMessage[]; search: string | null }
const views = new Map<string, ChatViewState>();
export function getChatViewState(sessionId: string): ChatViewState {
  let value = views.get(sessionId);
  if (!value) { value = { attachments: [], scrollTop: 0, follow: true, selectionStart: 0, selectionEnd: 0, search: null }; views.set(sessionId, value); }
  return value;
}
export function forgetChatViewState(sessionId: string) { const view = views.get(sessionId); view?.attachments.forEach(attachment => attachment.preview && URL.revokeObjectURL(attachment.preview)); views.delete(sessionId); }
