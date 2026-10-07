import { executionCapabilities, executionOptions, modelDisplayName } from "./agentExecution";
import { findCommand, type AgentCatalogue } from "./agentCommands";
import { useSessionStore, type ClaudeSession } from "../store/sessionStore";
import { useChatStore } from "../store/chatStore";
import { type ReasoningEffort, RUNNER_LABELS } from "../store/settingsStore";
import { commandCopy } from "../components/session/commandCopy";

/** Handle session controls locally and route interactive CLI commands deliberately. */
export function runChatCommand(prompt: string, session: ClaudeSession, catalogue: AgentCatalogue, locale: string, callbacks: { browse: (filter: "all" | "skill") => void; native: (query?: string) => void; notice: (text: string) => void }): boolean {
  const match = prompt.trim().match(/^\/([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) return false;
  const [, name, args = ""] = match; const c = commandCopy(locale);
  if (name === "help" || name === "skills") { callbacks.browse(name === "skills" ? "skill" : "all"); return true; }
  if (useChatStore.getState().threads[session.id]?.busy) throw new Error(c.busy);
  const workdir = session.worktreePath || session.workdir;
  const patch = (value: Partial<ClaudeSession["runner"]>) => {
    const next = { ...session.runner, ...value };
    useSessionStore.getState().updateSession(session.id, { runner: { ...next, ...executionOptions(next, workdir) } });
    callbacks.notice(`${c.changed}: /${name}${args ? ` ${args}` : ""}`);
  };
  if (name === "model") {
    if (!args) { callbacks.notice(c.modelHint); return true; }
    if (args.length > 200 || args.startsWith('-') || /\s|[\x00-\x1f]/.test(args)) throw new Error(c.modelHint);
    patch({ model: args === "default" ? "" : args }); return true;
  }
  if (name === "effort") {
    if (!executionCapabilities(session.runner, workdir).efforts.includes(args as ReasoningEffort)) throw new Error(c.effortHint);
    patch({ effort: args as ReasoningEffort, ultraMode: false }); return true;
  }
  if (name === "fast") {
    if (!/^(on|off)$/.test(args) || args === "on" && !executionCapabilities(session.runner, workdir).fast) throw new Error(c.fastHint);
    patch({ fastMode: args === "on" }); return true;
  }
  if ((name === "plan" || name === "code") && !args) { patch({ mode: name === "plan" ? "plan" : "default" }); return true; }
  if (name === "status" && !args) {
    const runner = session.runner;
    callbacks.notice(`${c.status}: ${session.name} · ${RUNNER_LABELS[runner.type]} · ${modelDisplayName(runner, workdir) || "default"} · ${runner.mode === "plan" ? "Plan" : "Code"} · ${runner.effort || "medium"}`);
    return true;
  }
  const entry = findCommand(prompt, catalogue);
  // Codex's app-server accepts skill inputs, not terminal slash commands.
  // Claude's initialization catalogue reports non-interactive command support.
  if (entry?.transport === "native" || session.runner.type === "codex" || !entry) {
    if (!entry) throw new Error(c.unknown);
    callbacks.native(prompt.trim()); return true;
  }
  return false;
}
