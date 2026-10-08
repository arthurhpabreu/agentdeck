import type { ChatMessage, ChatThread } from "../store/chatStore";
import { HISTORY_PAGE_SIZE, restoreCompactionPolicy } from "./chatCompaction";

const DATABASE = "agentdeck-chat-history-v1";
let database: Promise<IDBDatabase> | undefined;
function openDatabase(): Promise<IDBDatabase> {
  if (!database) database = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => {
      const messages = request.result.createObjectStore("messages", { keyPath: ["sessionId", "id"] });
      messages.createIndex("order", ["sessionId", "order"], { unique: true });
      messages.createIndex("session", "sessionId");
      request.result.createObjectStore("threads", { keyPath: "id" });
    };
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); database = undefined; }; resolve(db); };
    request.onerror = () => { database = undefined; reject(request.error); };
    request.onblocked = () => { database = undefined; reject(new Error("Chat history storage is blocked by another window.")); };
  }).catch(error => { database = undefined; throw error; });
  return database;
}
function completion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => { transaction.oncomplete = () => resolve(); transaction.onerror = transaction.onabort = () => reject(transaction.error ?? new Error("Chat history could not be saved.")); });
}
/** Writes changed messages only; the browser handles persistence off the render path. */
export async function saveChatHistory(id: string, thread: ChatThread, changed: ChatMessage[], deleted: string[] = []): Promise<number> {
  const db = await openDatabase(); const transaction = db.transaction(["messages", "threads"], "readwrite");
  const done = completion(transaction); const messages = transaction.objectStore("messages");
  for (const message of changed) messages.put({ ...message, sessionId: id });
  for (const messageId of deleted) messages.delete([id, messageId]);
  const count = messages.index("session").count(IDBKeyRange.only(id));
  let total = 0;
  count.onsuccess = () => {
    total = count.result;
    const { messages: _, ...metadata } = thread;
    transaction.objectStore("threads").put({ id, thread: { ...metadata, busy: false, status: undefined }, total });
  };
  await done; return total;
}
export async function restoreChatHistory(): Promise<Record<string, ChatThread>> {
  const db = await openDatabase();
  const metadata = await new Promise<{ id: string; thread: Omit<ChatThread, "messages">; total: number }[]>((resolve, reject) => {
    const request = db.transaction("threads").objectStore("threads").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
  });
  const threads: Record<string, ChatThread> = {};
  for (const record of metadata) {
    const messages = await readChatHistory(record.id);
    threads[record.id] = { ...record.thread, compactionPolicy: restoreCompactionPolicy(record.thread.compactionPolicy), messages: messages.map(m => m.role === "user" && (m.status === "queued" || m.status === "sending") ? { ...m, status: "failed" } : m.role === "tool" && ["running", "inProgress", "in_progress", "pending"].includes(m.status ?? "") ? { ...m, status: "interrupted" } : m), archivedCount: Math.max(0, record.total - messages.length), busy: false, compacting: false, turnId: undefined, status: undefined };
  }
  return threads;
}
export async function readChatHistory(id: string, before?: number, limit = HISTORY_PAGE_SIZE): Promise<ChatMessage[]> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("messages").objectStore("messages").index("order").openCursor(IDBKeyRange.bound([id, 0], [id, before ?? Number.MAX_SAFE_INTEGER], false, before !== undefined), "prev");
    const result: ChatMessage[] = [];
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { const cursor = request.result; if (!cursor || result.length >= limit) { resolve(result.reverse()); return; } const { sessionId: _, ...message } = cursor.value; result.push(message); cursor.continue(); };
  });
}
/** Recover a committed item before applying a late update to an evicted active-turn message. */
export async function readChatHistoryMessage(id: string, messageId: string): Promise<ChatMessage | undefined> {
  const db = await openDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("messages").objectStore("messages").get([id, messageId]);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => { if (!request.result) { resolve(undefined); return; } const { sessionId: _, ...message } = request.result; resolve(message); };
  });
}
/** Cursor-based search yields to IndexedDB between records and caps rendered results. */
export async function searchChatHistory(id: string, query: string): Promise<ChatMessage[]> {
  const db = await openDatabase(); const needle = query.toLocaleLowerCase();
  return new Promise((resolve, reject) => {
    const request = db.transaction("messages").objectStore("messages").index("order").openCursor(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]), "prev");
    const result: ChatMessage[] = [];
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const cursor = request.result;
      if (!cursor || result.length >= HISTORY_PAGE_SIZE) { resolve(result.reverse()); return; }
      const { sessionId: _, ...message } = cursor.value;
      if (matchesChatMessage(message, needle)) result.push(message);
      cursor.continue();
    };
  });
}
export function matchesChatMessage(message: ChatMessage, query: string): boolean {
  return `${message.title ?? ""} ${message.command ?? ""} ${message.cwd ?? ""} ${message.output ?? ""} ${message.text} ${message.attachments?.map(a => a.name).join(" ") ?? ""}`.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}
export async function deleteChatHistory(id: string): Promise<void> {
  const db = await openDatabase(); const transaction = db.transaction(["messages", "threads"], "readwrite"); const done = completion(transaction);
  transaction.objectStore("threads").delete(id);
  const request = transaction.objectStore("messages").index("session").openKeyCursor(IDBKeyRange.only(id));
  request.onsuccess = () => { const cursor = request.result; if (cursor) { transaction.objectStore("messages").delete(cursor.primaryKey); cursor.continue(); } };
  await done;
}
