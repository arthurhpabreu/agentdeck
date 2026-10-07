import { useState } from "react";
import { Brain, Check, LoaderCircle } from "lucide-react";
import { useAppI18n } from "../../i18n";
import { useWorkspaceStore } from "../../store/workspaceStore";
import type { ClaudeSession } from "../../store/sessionStore";
import { memoryCommands } from "../../services/memoryCommands";
import { memoryCopy } from "./memoryCopy";

function byteExcerpt(text: string, limit: number) {
  let result = ""; let bytes = 0; const encoder = new TextEncoder();
  for (const character of text) { const size = encoder.encode(character).length; if (bytes + size > limit) break; result += character; bytes += size; }
  return result;
}

export function SaveResponseToMemory({ session, text, disabled, onError }: { session: ClaudeSession; text: string; disabled: boolean; onError: (error: string) => void }) {
  const { locale } = useAppI18n(); const m = memoryCopy(locale);
  const [saving, setSaving] = useState(false); const [saved, setSaved] = useState(false);
  const save = async () => {
    if (!text.trim() || saving || saved) return;
    setSaving(true);
    try {
      let content = byteExcerpt(text, 11000);
      if (content !== text) content = `${m.responseExcerpt}\n\n${content}`;
      const project = useWorkspaceStore.getState().workspaces.find(workspace => workspace.id === session.workspaceId)?.path || session.workdir;
      await memoryCommands.save(project, { title: byteExcerpt((text.split("\n").find(line => line.trim()) || session.name).replace(/^#+\s*/, ""), 220), content, kind: "handoff", pinned: false, sourceSessionId: session.id, provider: session.runner.type });
      setSaved(true);
    } catch (error) { onError(`${m.actionFailure} ${String(error)}`); }
    finally { setSaving(false); }
  };
  return <button className="ad-icon-button" disabled={disabled || saving || saved || !text.trim()} aria-label={saved ? m.savedToMemory : m.saveAnswer} title={saved ? m.savedToMemory : m.saveAnswer} onClick={() => void save()}>{saving ? <LoaderCircle size={14} /> : saved ? <Check size={14} /> : <Brain size={14} />}</button>;
}
