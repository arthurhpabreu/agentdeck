import { invoke } from "@tauri-apps/api/core";
import { useAttentionStore } from "../store/attentionStore";

interface InputTask { bytes: Uint8Array; offset: number; resolve: () => void; reject: (error: unknown) => void }
const queues = new Map<string, { normal: InputTask[]; control: InputTask[]; running: boolean }>();
function base64(bytes: Uint8Array) { const chunks: string[] = []; for (let offset = 0; offset < bytes.length; offset += 8192) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 8192))); return btoa(chunks.join("")); }

/** Large pastes yield between byte chunks. Interrupt input gets a slot at the next boundary. */
export function writePtyInput(sessionId: string, data: string): Promise<void> {
  // Typing in the terminal answers its permission dialog.
  useAttentionStore.getState().resolveTerminalPrompt(sessionId);
  return new Promise((resolve, reject) => {
    const queue = queues.get(sessionId) ?? { normal: [], control: [], running: false };
    queues.set(sessionId, queue);
    const task = { bytes: new TextEncoder().encode(data), offset: 0, resolve, reject };
    (data === "\x03" || data === "\x1b" ? queue.control : queue.normal).push(task);
    if (queue.running) return;
    queue.running = true;
    void (async () => {
      while (queue.normal.length || queue.control.length) {
        const source = queue.control.length ? queue.control : queue.normal;
        const task = source[0];
        try {
          const end = Math.min(task.bytes.length, task.offset + 16384);
          await invoke("write_pty", { sessionId, data: base64(task.bytes.subarray(task.offset, end)) });
          task.offset = end;
          if (end === task.bytes.length) { source.shift(); task.resolve(); }
          else await new Promise(resolve => setTimeout(resolve, 0));
        } catch (error) { source.shift(); task.reject(error); }
      }
      queue.running = false; queues.delete(sessionId);
    })();
  });
}
