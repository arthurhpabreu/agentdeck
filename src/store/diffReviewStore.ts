import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import { mirroredPersistStorage } from "./persistStorage";
import { createUuid } from "../services/ids";
import type { DiffFile } from "./sessionStore";

export interface DiffReviewComment { id: string; sessionId: string; path: string; side: "old" | "new"; start: number; end: number; revision: string; context: string; text: string; at: number }
/** Two independent hashes include the complete rendered diff, not only the selected line. */
export function diffRevision(file: DiffFile): string {
  const text = JSON.stringify(file); let left = 2166136261; let right = 5381;
  for (let index = 0; index < text.length; index++) { const unit = text.charCodeAt(index); left = Math.imul(left ^ unit, 16777619); right = Math.imul(right, 33) ^ unit; }
  return `${text.length}:${(left >>> 0).toString(16)}:${(right >>> 0).toString(16)}`;
}
export function diffContext(file: DiffFile, side: "old" | "new", start: number, end: number): string {
  const lines = file.hunks.flatMap(hunk => hunk.lines);
  const matching = lines.map((line, index) => ({ line, index })).filter(({ line }) => { const n = side === "old" ? line.oldLineNo : line.newLineNo; return n !== undefined && n >= start && n <= end; });
  if (!matching.length) return "";
  return lines.slice(Math.max(0, matching[0].index - 3), matching[matching.length - 1].index + 4).map(line => `${line.type === "added" ? "+" : line.type === "deleted" ? "-" : " "}${line.oldLineNo ?? ""}:${line.newLineNo ?? ""} ${line.content}`).join("\n");
}
export function buildDiffReviewPrompt(comments: DiffReviewComment[]): string {
  return ["Please review and apply the following code review comments together. Check the current file and diff before editing. Treat quoted code as context, preserve unrelated changes, and explain any comment that cannot be applied.", ...comments.map(comment => `File: ${JSON.stringify(comment.path)}\nSide: ${comment.side}; lines ${comment.start}-${comment.end}; diff revision: ${comment.revision}\nComment:\n${comment.text}\nContext (quoted):\n${JSON.stringify(comment.context)}`)].join("\n\n");
}
export const useDiffReviewStore = create<{
  comments: DiffReviewComment[];
  add: (comment: Omit<DiffReviewComment, "id" | "at">) => void;
  remove: (id: string) => void;
  reanchor: (id: string, file: DiffFile) => void;
  removeBatch: (ids: string[]) => void;
}>()(persist(set => ({
  comments: [],
  add: comment => set(state => ({ comments: [...state.comments, { ...comment, id: createUuid(), at: Date.now() }] })),
  remove: id => set(state => ({ comments: state.comments.filter(comment => comment.id !== id) })),
  reanchor: (id, file) => set(state => ({ comments: state.comments.map(comment => comment.id === id ? { ...comment, revision: diffRevision(file), context: diffContext(file, comment.side, comment.start, comment.end) } : comment) })),
  removeBatch: ids => set(state => ({ comments: state.comments.filter(comment => !ids.includes(comment.id)) })),
}), { name: "agentdeck-diff-review-v1", storage: createJSONStorage(() => mirroredPersistStorage) }));
