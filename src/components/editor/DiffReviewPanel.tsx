import { useState } from "react";
import { useAppI18n } from "../../i18n";
import { useDiffReviewStore, buildDiffReviewPrompt, diffRevision, diffContext } from "../../store/diffReviewStore";
import { useSessionStore, type DiffFile } from "../../store/sessionStore";
import { sendChatTurn } from "../../store/chatStore";
import { showSessionSurface } from "../../services/workbenchCommands";
import { improvementsCopy } from "../platformImprovementsCopy";

export function DiffReviewPanel({ sessionId, files }: { sessionId: string; files: DiffFile[] }) {
  const { locale } = useAppI18n(); const c = improvementsCopy(locale);
  const comments = useDiffReviewStore(state => state.comments).filter(comment => comment.sessionId === sessionId);
  const sessions = useSessionStore(state => state.sessions);
  const workspace = sessions.find(session => session.id === sessionId)?.workspaceId;
  const targets = sessions.filter(session => session.workspaceId === workspace && session.runner.type !== "gemini");
  const [target, setTarget] = useState(sessionId); const [pending, setPending] = useState(false); const [error, setError] = useState("");
  if (!comments.length) return null;
  const allFiles = [...(sessions.find(session => session.id === sessionId)?.diffFiles ?? []), ...files];
  const fileFor = (path: string) => [...allFiles].reverse().find(file => file.path === path);
  const stale = comments.some(comment => !fileFor(comment.path) || diffRevision(fileFor(comment.path)!) !== comment.revision);
  return <aside className="ad-diff-review" aria-label={c.review}><h3>{c.review} ({comments.length})</h3>
    {comments.map(comment => { const file = fileFor(comment.path); const changed = !file || diffRevision(file) !== comment.revision;
      return <article key={comment.id}><strong>{comment.path}:{comment.start}-{comment.end} ({comment.side})</strong><p>{comment.text}</p>{changed && <p role="status">{c.stale}</p>}{changed && file && diffContext(file, comment.side, comment.start, comment.end) && <button className="ad-button" onClick={() => useDiffReviewStore.getState().reanchor(comment.id, file)}>{c.reanchor}</button>}<button className="ad-button ad-button-ghost" onClick={() => useDiffReviewStore.getState().remove(comment.id)}>{c.remove}</button></article>;
    })}
    <label>{c.agent} <select aria-label={c.agent} value={target} onChange={event => setTarget(event.target.value)}>{targets.map(session => <option key={session.id} value={session.id}>{session.name}</option>)}</select></label>
    <button className="ad-button" disabled={stale || pending || !targets.some(session => session.id === target)} onClick={() => {
      const recipient = useSessionStore.getState().sessions.find(session => session.id === target);
      if (!recipient || recipient.workspaceId !== workspace) return;
      setPending(true); setError("");
      void sendChatTurn(target, buildDiffReviewPrompt(comments), []).then(sent => { if (sent) { useDiffReviewStore.getState().removeBatch(comments.map(comment => comment.id)); showSessionSurface(target); } }).catch(failure => setError(String(failure))).finally(() => setPending(false));
    }}>{c.send}</button>{error && <p role="alert">{error}</p>}
  </aside>;
}
