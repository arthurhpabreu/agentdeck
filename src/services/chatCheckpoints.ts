import { useChatStore, chatHistoryReady, persistChatHistory, emptyThread, type ChatThread } from "../store/chatStore";
import { useSessionStore } from "../store/sessionStore";
import { usePtyRuntimeStore } from "../store/ptyRuntimeStore";
import { readCompleteChatHistory } from "./chatHistory";
import { saveContinuityArchive } from "./chatContinuity";
import { createUuid } from "./ids";

export interface ChatCheckpoint { id: string; version: 1; sessionId: string; name: string; at: number; archivePath: string; thread: ChatThread }
export interface ChatCheckpointSummary extends Omit<ChatCheckpoint, "thread"> { messageCount: number }
const summaryOf = ({ id, version, sessionId, name, at, archivePath, thread }: ChatCheckpoint): ChatCheckpointSummary => ({ id, version, sessionId, name, at, archivePath, messageCount: thread.messages.length });
const newestFirst = (a: ChatCheckpointSummary, b: ChatCheckpointSummary) => b.at - a.at || b.id.localeCompare(a.id);
let database: Promise<IDBDatabase> | undefined;
function db() {
  return database ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("agentdeck-chat-checkpoints", 2);
    let blocked = false;
    request.onupgradeneeded = () => {
      const connection = request.result;
      if (!connection.objectStoreNames.contains("checkpoints")) {
        connection.createObjectStore("checkpoints", { keyPath: "id" }).createIndex("session", "sessionId");
      }
      if (!connection.objectStoreNames.contains("summaries")) {
        const summaries = connection.createObjectStore("summaries", { keyPath: "id" });
        summaries.createIndex("session", "sessionId");
        // Upgrade within one transaction, reading one old history at a time.
        // The complete checkpoint records are preserved without modification.
        const cursor = request.transaction!.objectStore("checkpoints").openCursor();
        cursor.onsuccess = () => {
          if (!cursor.result) return;
          summaries.put(summaryOf(cursor.result.value as ChatCheckpoint));
          cursor.result.continue();
        };
      }
    };
    request.onsuccess = () => {
      if (blocked) { request.result.close(); return; }
      const connection = request.result;
      connection.onversionchange = () => { connection.close(); database = undefined; };
      resolve(connection);
    };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { blocked = true; database = undefined; reject(new Error("Checkpoint storage is blocked.")); };
  });
}
export async function listChatCheckpoints(sessionId: string): Promise<ChatCheckpointSummary[]> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const request = connection.transaction("summaries").objectStore("summaries").index("session").getAll(IDBKeyRange.only(sessionId));
    request.onsuccess = () => resolve((request.result as ChatCheckpointSummary[]).filter(checkpoint => checkpoint.sessionId === sessionId).sort(newestFirst));
    request.onerror = () => reject(request.error);
  });
}
export async function readCheckpoint(sessionId: string, id: string): Promise<ChatCheckpoint> {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(["summaries", "checkpoints"]);
    const summary = transaction.objectStore("summaries").get(id);
    const unavailable = () => reject(new Error("Checkpoint does not belong to this conversation or is no longer available."));
    summary.onsuccess = () => {
      if (!summary.result || summary.result.sessionId !== sessionId) { unavailable(); return; }
      const request = transaction.objectStore("checkpoints").get(id);
      request.onsuccess = () => {
        const checkpoint = request.result as ChatCheckpoint | undefined;
        if (!checkpoint || checkpoint.sessionId !== sessionId) unavailable();
        else resolve(checkpoint);
      };
      request.onerror = () => reject(request.error);
    };
    summary.onerror = () => reject(summary.error);
  });
}
function assertStopped(sessionId: string) {
  if (!useSessionStore.getState().sessions.some(session => session.id === sessionId)) throw new Error("The conversation is no longer available.");
  if (useChatStore.getState().threads[sessionId]?.busy || usePtyRuntimeStore.getState().sessions[sessionId]) throw new Error("Stop the active response before saving a checkpoint.");
}
const saving = new Set<string>();
export async function saveChatCheckpoint(sessionId: string): Promise<ChatCheckpoint> {
  if (saving.has(sessionId)) throw new Error("A checkpoint is already being saved.");
  saving.add(sessionId);
  try {
    await chatHistoryReady;
    assertStopped(sessionId);
    await persistChatHistory(); if (useChatStore.getState().storageError) throw new Error("Chat history is not durably saved.");
    assertStopped(sessionId);
    const session = useSessionStore.getState().sessions.find(session => session.id === sessionId)!;
    const thread = useChatStore.getState().threads[sessionId] ?? emptyThread;
    const messages = await readCompleteChatHistory(sessionId, thread.messages, thread.archivedCount);
    assertStopped(sessionId);
    const at = Date.now(); const archivePath = await saveContinuityArchive(session, thread, messages, at);
    assertStopped(sessionId);
    const checkpoint: ChatCheckpoint = { id: createUuid(), version: 1, sessionId, name: session.name, at, archivePath, thread: { ...thread, messages, busy: false, compacting: false, providerSessionId: undefined, turnId: undefined, mcpAuthWarning: undefined, mcpAuthWarningUntil: undefined } };
    const connection = await db();
    assertStopped(sessionId);
    await new Promise<void>((resolve, reject) => {
      const transaction = connection.transaction(["checkpoints", "summaries"], "readwrite");
      const records = transaction.objectStore("checkpoints"), summaries = transaction.objectStore("summaries");
      records.put(checkpoint); summaries.put(summaryOf(checkpoint));
      const prior = summaries.index("session").getAll(IDBKeyRange.only(sessionId));
      prior.onsuccess = () => (prior.result as ChatCheckpointSummary[]).sort(newestFirst).slice(10).forEach(old => { records.delete(old.id); summaries.delete(old.id); });
      transaction.oncomplete = () => resolve();
      transaction.onerror = transaction.onabort = () => reject(transaction.error);
    });
    return checkpoint;
  } finally { saving.delete(sessionId); }
}
