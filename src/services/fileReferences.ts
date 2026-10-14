import { openFile, loadFile } from "./editorCommands";
import { useSessionStore } from "../store/sessionStore";
import { useNavigationStore } from "../store/navigationStore";
import { useEditorLocationStore } from "../store/editorLocationStore";

export function parseFileReference(href: string, workdir: string): { path: string; line: number } | undefined {
  let value: string; try { value = decodeURIComponent(href).replace(/^file:\/\//i, "").replace(/\\/g, "/"); } catch { return; }
  const match = value.match(/^(.*?)(?::(\d+)(?::\d+)?|#L(\d+)(?:-L?\d+)?)?$/); if (!match) return;
  let path = match[1]; const root = workdir.replace(/\\/g, "/").replace(/\/$/, "");
  if (path.startsWith("/") && /^[A-Za-z]:\//.test(path.slice(1))) path = path.slice(1);
  if (path.toLowerCase().startsWith(root.toLowerCase() + "/")) path = path.slice(root.length + 1);
  if (!path || /^\w+:/.test(path) || path.startsWith("/") || path.split("/").includes("..")) return;
  return { path: path.replace(/^\.\//, ""), line: Math.max(1, Number(match[2] ?? match[3] ?? 1)) };
}
export async function openFileReference(sessionId: string, href: string) {
  const session = useSessionStore.getState().sessions.find(item => item.id === sessionId); if (!session) return;
  const reference = parseFileReference(href, session.worktreePath || session.workdir); if (!reference) return;
  const tabId = openFile(sessionId, reference.path, false, true, "command");
  useNavigationStore.getState().visit(`file:${sessionId}:${reference.path}`);
  await loadFile(tabId);
  useEditorLocationStore.getState().setLocation(sessionId, reference.path, reference.line);
}
