import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { BookOpen, FileCode, FolderOpen, Network, Search, Settings2, Star, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import { useAttentionStore } from "../../store/attentionStore";
import { useNavigationStore } from "../../store/navigationStore";
import { openFileReference } from "../../services/fileReferences";
import { improvementsCopy } from "../platformImprovementsCopy";
import { orderingCopy } from "../ordering/orderingCopy";
import { SortableCollection } from "../ordering/SortableCollection";
import { applyPresentationOrder, presentationKey, usePresentationStore } from "../../store/presentationStore";
import { useAppI18n } from "../../i18n";
import { RUNNER_LABELS } from "../../store/settingsStore";
import { selectSessionNavigation, useSessionStore } from "../../store/sessionStore";
import { useWorkspaceStore } from "../../store/workspaceStore";
import { useWorkbenchStore } from "../../store/workbenchStore";
import { showSessionSurface } from "../../services/workbenchCommands";
import { getRuntimePlatform } from "../../services/platform";
import { ProviderIcon } from "../ProviderIcon";
import { quickSwitchCopy } from "./quickSwitchCopy";
import "./quickSwitch.css";

interface Props { disabled?: boolean; onAgents: () => void; onKnowledge: () => void; onSettings: () => void }
interface Entry { id: string; title: string; detail: string; icon: ReactNode; current?: boolean; score: number; select: () => void }
interface Group { id: string; title: string; entries: Entry[]; score: number }

const normalize = (value: string) => value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
function scoreMatch(query: string, ...fields: string[]): number {
  const tokens = normalize(query).trim().split(/\s+/).filter(Boolean);
  if (!tokens.length) return 0;
  const normalized = fields.map(field => normalize(field).slice(0, 1200));
  let total = 0;
  for (const token of tokens) {
    let best = -1;
    for (const [fieldIndex, field] of normalized.entries()) {
      const index = field.indexOf(token);
      if (index >= 0) { best = Math.max(best, (index === 0 ? 60 : 40) - fieldIndex * 6); continue; }
      if (token.length < 3) continue;
      let cursor = -1, first = -1;
      for (const character of token) {
        cursor = field.indexOf(character, cursor + 1);
        if (cursor < 0) break;
        if (first < 0) first = cursor;
      }
      const gaps = cursor - first + 1 - token.length;
      if (cursor >= 0 && gaps <= token.length * 2) best = Math.max(best, 15 - fieldIndex - gaps);
    }
    if (best < 0) return -1;
    total += best;
  }
  return total;
}

function otherDialogOpen(own: HTMLDialogElement | null): boolean {
  return [...document.querySelectorAll<HTMLElement>('dialog[open], [role="dialog"], [role="alertdialog"], [aria-modal="true"]')]
    .some(element => element !== own && !element.closest("[hidden], [aria-hidden='true']") && element.getClientRects().length > 0);
}

/** Navigation only: this component never creates sessions or starts provider processes. */
export function QuickSwitch({ disabled = false, onAgents, onKnowledge, onSettings }: Props) {
  const { locale, t } = useAppI18n();
  const copy = quickSwitchCopy(locale);
  const improvements = improvementsCopy(locale);
  const ordering = orderingCopy(locale);
  const sessions = useSessionStore(selectSessionNavigation);
  const activeSessionId = useSessionStore(state => state.activeSessionId);
  const workspaces = useWorkspaceStore(state => state.workspaces);
  const activeWorkspaceId = useWorkspaceStore(state => state.activeWorkspaceId);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeId, setActiveId] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const id = useId();
  const listId = `${id}-results`;
  const isMac = getRuntimePlatform().os === "macos";
  const favorites = useNavigationStore(state => state.favorites);
  const presentationLayouts = usePresentationStore(state => state.layouts);
  const [snapshot, setSnapshot] = useState(() => ({ sessions, workspaces, activeSessionId, activeWorkspaceId, favorites: [] as string[], recent: [] as string[], attention: [] as string[] }));
  const [fileResults, setFileResults] = useState<string[]>([]);
  const [filesLimited, setFilesLimited] = useState(false);

  const close = useCallback((action?: () => void) => {
    dialog.current?.close();
    setOpen(false);
    const previous = action ? trigger.current : restoreFocus.current;
    const target = previous?.isConnected && previous.getClientRects().length ? previous : trigger.current;
    target?.focus({ preventScroll: true });
    action?.();
  }, []);

  const openSearch = useCallback(() => {
    if (disabled || otherDialogOpen(dialog.current)) return;
    restoreFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : trigger.current;
    const navigation = useNavigationStore.getState();
    setSnapshot({ sessions: useSessionStore.getState().sessions.map(session => ({ ...session })), workspaces: useWorkspaceStore.getState().workspaces.map(workspace => ({ ...workspace })), activeSessionId: useSessionStore.getState().activeSessionId, activeWorkspaceId: useWorkspaceStore.getState().activeWorkspaceId, favorites: [...navigation.favorites], recent: [...navigation.recent], attention: useAttentionStore.getState().items.filter(item => !item.read).map(item => item.sessionId) });
    setFileResults([]); setFilesLimited(false);
    setQuery(""); setActiveId(null); setOpen(true);
  }, [disabled]);

  useEffect(() => {
    if (!open || !snapshot.activeSessionId) return;
    let cancelled = false; setFileResults([]); setFilesLimited(false);
    const searchQuery = query.replace(/(?::\d+(?::\d+)?|#L\d+)$/, "");
    const timer = setTimeout(() => { void invoke<{ paths: string[]; truncated: boolean }>("search_session_files", { sessionId: snapshot.activeSessionId, query: searchQuery }).then(result => { if (!cancelled && result?.paths) { setFileResults(result.paths); setFilesLimited(result.truncated); } }).catch(() => {}); }, 150);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [open, query, snapshot.activeSessionId]);

  useEffect(() => {
    if (!open) return;
    const element = dialog.current;
    if (!element) return;
    element.showModal();
    input.current?.focus({ preventScroll: true });
    return () => { if (element.open) element.close(); };
  }, [open]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey || !(event.ctrlKey || event.metaKey) || event.key.toLowerCase() !== "k") return;
      const target = event.target instanceof Element ? event.target : document.activeElement;
      if (disabled || otherDialogOpen(dialog.current) || target?.closest(".xterm")) return;
      event.preventDefault(); event.stopPropagation();
      if (open) close(); else openSearch();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [close, disabled, open, openSearch]);

  const groups = useMemo(() => {
    if (!open) return [];
    const { sessions, workspaces, activeWorkspaceId, activeSessionId } = snapshot;
    const priority = (id: string, sessionId?: string) => (sessionId && snapshot.attention.includes(sessionId) ? 100 : 0) + (snapshot.favorites.includes(id) ? 70 : 0) + (snapshot.recent.includes(id) ? 20 - Math.min(19, snapshot.recent.indexOf(id)) : 0);
    const groups: Group[] = [];
    for (const workspace of [...workspaces].sort((left, right) => Number(right.id === activeWorkspaceId) - Number(left.id === activeWorkspaceId) || left.order - right.order)) {
      const projectSessions = sessions.filter(session => session.workspaceId === workspace.id);
      const projectScore = scoreMatch(query, workspace.name, workspace.path);
      const entries: Entry[] = [];
      if (projectScore >= 0) entries.push({
        id: `project:${workspace.id}`, title: workspace.name,
        detail: `${copy.project} · ${workspace.path} · ${projectSessions.length} ${copy.conversations}`,
        icon: <FolderOpen size={18} />, current: workspace.id === activeWorkspaceId, score: projectScore,
        select: () => {
          if (!useWorkspaceStore.getState().workspaces.some(item => item.id === workspace.id)) return;
          useWorkspaceStore.getState().setActiveWorkspace(workspace.id);
          const current = useSessionStore.getState().sessions.find(session => session.workspaceId === workspace.id && session.id === useSessionStore.getState().activeSessionId);
          const sessionId = current?.id ?? useSessionStore.getState().sessions.find(session => session.workspaceId === workspace.id)?.id ?? null;
          useSessionStore.getState().setActiveSession(sessionId);
          useSessionStore.getState().setExpandedSession(null);
          useWorkbenchStore.getState().resetWorkbenchMode();
        },
      });
      for (const session of projectSessions) {
        const provider = RUNNER_LABELS[session.runner.type];
        const score = scoreMatch(query, session.name, workspace.name, session.worktreePath || session.workdir, provider, t(`status.${session.status}`));
        if (score < 0) continue;
        entries.push({
          id: `session:${session.id}`, title: session.name,
          detail: `${provider} · ${t(`status.${session.status}`)}${session.branchName ? ` · ${session.branchName}` : ""}`,
          icon: <ProviderIcon provider={session.runner.type} size={18} />, current: session.id === activeSessionId,
          score: score + priority(`session:${session.id}`, session.id), select: () => {
            const current = useSessionStore.getState().sessions.find(item => item.id === session.id);
            if (!current) return;
            useWorkspaceStore.getState().setActiveWorkspace(current.workspaceId);
            showSessionSurface(current.id);
          },
        });
      }
      if (entries.length) groups.push({ id: workspace.id, title: workspace.name, entries: entries.sort((a, b) => b.score - a.score), score: Math.max(...entries.map(entry => entry.score)) });
    }
    const actions = [
      { id: "agents", title: copy.agents, detail: copy.agentsHint, keywords: "agents agentes monitor", icon: <Network size={18} />, select: onAgents },
      { id: "knowledge", title: copy.knowledge, detail: copy.knowledgeHint, keywords: "knowledge conhecimento conocimiento memory memoria", icon: <BookOpen size={18} />, select: onKnowledge },
      { id: "settings", title: copy.settings, detail: copy.settingsHint, keywords: "settings configuracoes configuracion preferences", icon: <Settings2 size={18} />, select: onSettings },
    ].map(action => ({ ...action, id: `action:${action.id}`, score: scoreMatch(query, action.title, action.keywords) })).filter(action => action.score >= 0).sort((a, b) => b.score - a.score);
    if (actions.length) groups.push({ id: "actions", title: copy.actions, entries: actions, score: Math.max(...actions.map(action => action.score)) });
    const filePrefix = `file:${activeSessionId}:`;
    const rememberedFiles = [...snapshot.favorites, ...snapshot.recent].filter(id => id.startsWith(filePrefix)).map(id => id.slice(filePrefix.length)).filter(path => scoreMatch(query.replace(/(?::\d+(?::\d+)?|#L\d+)$/, ""), path) >= 0);
    const files = [...new Set([...fileResults, ...rememberedFiles])].map(path => ({ id: `${filePrefix}${path}`, title: path, detail: `${improvements.files} · ${sessions.find(session => session.id === activeSessionId)?.name ?? ""}`, icon: <FileCode size={18}/>, score: priority(`${filePrefix}${path}`), select: () => { if (activeSessionId) { showSessionSurface(activeSessionId); void openFileReference(activeSessionId, path + (query.match(/(?::\d+(?::\d+)?|#L\d+)$/)?.[0] ?? "")); } } }));
    if (files.length) groups.push({ id: "files", title: improvements.files, entries: files.sort((a, b) => b.score - a.score), score: Math.max(...files.map(file => file.score)) });
    groups.sort((a, b) => b.score - a.score);
    if (!query.trim()) {
      const favorites = groups.flatMap(group => group.entries).filter(entry => snapshot.favorites.includes(entry.id));
      const recent = snapshot.recent.map(id => groups.flatMap(group => group.entries).find(entry => entry.id === id)).filter((entry): entry is Entry => !!entry && !snapshot.favorites.includes(entry.id));
      const promoted = new Set([...favorites, ...recent].map(entry => entry.id));
      groups.forEach(group => { group.entries = group.entries.filter(entry => !promoted.has(entry.id)); });
      if (recent.length) groups.unshift({ id: "recent", title: improvements.recent, entries: recent, score: 0 });
      if (favorites.length) groups.unshift({ id: "favorites", title: improvements.favorites, entries: favorites, score: 0 });
    }
    return groups;
  }, [snapshot, fileResults, improvements.files, improvements.favorites, improvements.recent, copy, onAgents, onKnowledge, onSettings, open, query, t]);

  const orderedGroups = groups.map(group => { const byId = new Map(group.entries.map(entry => [entry.id, entry])); return { ...group, entries: applyPresentationOrder([...byId.keys()], presentationLayouts[presentationKey(`quick-switch-${group.id}`, snapshot.activeWorkspaceId ?? "all")]?.order).map(id => byId.get(id)!) }; });
  const entries = orderedGroups.flatMap(group => group.entries).slice(0, 60);
  const selected = entries.find(entry => entry.id === activeId) ?? entries[0];
  const optionId = (entryId: string) => `${id}-${encodeURIComponent(entryId)}`;
  useEffect(() => {
    if (open && selected) document.getElementById(optionId(selected.id))?.scrollIntoView({ block: "nearest" });
  }, [open, selected?.id]);

  return <>
    <button ref={trigger} type="button" className="ad-quick-switch-trigger" disabled={disabled} aria-haspopup="dialog" aria-expanded={open}
      aria-keyshortcuts={isMac ? "Meta+K" : "Control+K"} onClick={openSearch}>
      <Search size={15} aria-hidden="true" /><span>{copy.trigger}</span><kbd aria-hidden="true">{isMac ? "⌘ K" : "Ctrl K"}</kbd>
    </button>
    {createPortal(<dialog ref={dialog} className="ad-quick-switch" aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); close(); }}
      onDoubleClick={event => event.stopPropagation()}
      onClick={event => { if (event.target === event.currentTarget) { const bounds = event.currentTarget.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) close(); } }}
      onKeyDown={event => {
        if (event.key === "Tab") {
          const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("input, button, [tabindex]")]
            .filter(element => element.tabIndex >= 0 && !element.matches(":disabled") && element.getClientRects().length > 0);
          if (controls.length) {
            event.preventDefault(); event.stopPropagation();
            const current = controls.findIndex(element => element === document.activeElement);
            const next = current < 0 ? (event.shiftKey ? controls.length - 1 : 0)
              : (current + (event.shiftKey ? -1 : 1) + controls.length) % controls.length;
            controls[next].focus({ preventScroll: true });
          }
          return;
        }
        if (event.key === "Escape") { if (event.currentTarget.querySelector('[data-dragging="true"]')) return; event.preventDefault(); event.stopPropagation(); close(); }
        if (event.isPropagationStopped() || event.nativeEvent.isComposing || event.target !== input.current) return;
        if (event.altKey && ["z", "r"].includes(event.key.toLowerCase()) && selected) { event.preventDefault(); const group = orderedGroups.find(group => group.entries.includes(selected)); if (group) usePresentationStore.getState()[event.key.toLowerCase() === "z" ? "undo" : "reset"](`quick-switch-${group.id}`, snapshot.activeWorkspaceId ?? "all"); }
        else if (event.altKey && (event.key === "ArrowDown" || event.key === "ArrowUp") && selected) {
          event.preventDefault(); const group = orderedGroups.find(group => group.entries.includes(selected)); if (!group) return;
          const ids = group.entries.map(entry => entry.id), index = ids.indexOf(selected.id), over = ids[index + (event.key === "ArrowDown" ? 1 : -1)];
          const complete = [...new Set([...(presentationLayouts[presentationKey(`quick-switch-${group.id}`, snapshot.activeWorkspaceId ?? "all")]?.order ?? []), ...ids])];
          if (over) usePresentationStore.getState().moveItem(`quick-switch-${group.id}`, snapshot.activeWorkspaceId ?? "all", complete, ids, selected.id, over);
        } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          if (entries.length) { const current = entries.findIndex(entry => entry.id === selected?.id); setActiveId(entries[(current + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length].id); }
        } else if (event.altKey && event.key.toLowerCase() === "f" && selected) { event.preventDefault(); useNavigationStore.getState().toggleFavorite(selected.id); }
        else if (event.key === "Enter") { event.preventDefault(); if (selected) close(() => { useNavigationStore.getState().visit(selected.id); selected.select(); }); }
      }}>
      <h2 id={`${id}-title`} className="ad-quick-switch-sr">{copy.title}</h2>
      <div className="ad-quick-switch-search">
        <Search size={20} aria-hidden="true" />
        <input ref={input} type="search" role="combobox" aria-label={copy.search} placeholder={copy.search} autoComplete="off" spellCheck={false} maxLength={200}
          aria-autocomplete="list" aria-expanded={open} aria-controls={listId} aria-activedescendant={selected ? optionId(selected.id) : undefined}
          value={query} onChange={event => { setQuery(event.target.value); setActiveId(null); }} />
        <button type="button" className="ad-quick-switch-close" onClick={() => close()} aria-label={copy.close}><X size={18} /></button>
      </div>
      <div className="ad-quick-switch-results" id={listId} role="listbox" aria-label={copy.title}>
        {orderedGroups.map(group => {
          const visible = group.entries.filter(entry => entries.includes(entry));
          if (!visible.length) return null;
          const projectFirst = visible[0].id.startsWith("project:");
          return <div key={group.id} role="group" aria-label={group.title} className="ad-quick-switch-group">
            {!projectFirst && <div className="ad-quick-switch-group-label" aria-hidden="true">{group.title}</div>}
            {!!presentationLayouts[presentationKey(`quick-switch-${group.id}`, snapshot.activeWorkspaceId ?? "all")]?.order && <div className="ad-arrangement-controls"><button tabIndex={-1} title={`${ordering.undo} (Alt+Z)`} onClick={() => usePresentationStore.getState().undo(`quick-switch-${group.id}`, snapshot.activeWorkspaceId ?? "all")}>{ordering.undo}</button><button tabIndex={-1} title={`${ordering.reset} (Alt+R)`} onClick={() => usePresentationStore.getState().reset(`quick-switch-${group.id}`, snapshot.activeWorkspaceId ?? "all")}>{ordering.reset}</button></div>}
            <SortableCollection surface={`quick-switch-${group.id}`} context={snapshot.activeWorkspaceId ?? "all"} items={visible} allIds={[...new Set([...(presentationLayouts[presentationKey(`quick-switch-${group.id}`, snapshot.activeWorkspaceId ?? "all")]?.order ?? []), ...group.entries.map(entry => entry.id)])]} getId={entry => entry.id} getLabel={entry => entry.title} handleTabIndex={-1} toolbar={false} render={(entry, handle) => <div id={optionId(entry.id)} role="option" aria-selected={entry.id === selected?.id}
              className={`ad-quick-switch-option${entry.id.startsWith("session:") ? " is-session" : ""}`} onMouseMove={() => setActiveId(entry.id)} onMouseDown={event => event.preventDefault()} onClick={() => close(() => { useNavigationStore.getState().visit(entry.id); entry.select(); })}>
              {handle}
              <span className="ad-quick-switch-icon" aria-hidden="true">{entry.icon}</span>
              <span className="ad-quick-switch-text"><strong>{entry.title}</strong><span>{entry.detail}</span></span>
              {entry.current && <span className="ad-quick-switch-current">{copy.current}</span>}
              <button type="button" tabIndex={-1} className="ad-icon-button" aria-label={favorites.includes(entry.id) ? improvements.unfavorite : improvements.favorite} title={`${improvements.favorite} (Alt+F)`} aria-pressed={favorites.includes(entry.id)} onClick={event => { event.stopPropagation(); useNavigationStore.getState().toggleFavorite(entry.id); }}><Star size={15} fill={favorites.includes(entry.id) ? "currentColor" : "none"}/></button>
            </div>}/>
          </div>;
        })}
      </div>
      {!entries.length && <div className="ad-quick-switch-empty"><strong>{copy.empty}</strong><p>{copy.emptyHint}</p><button type="button" onClick={() => { setQuery(""); input.current?.focus(); }}>{copy.clear}</button></div>}
      <p className="ad-quick-switch-sr" role="status" aria-live="polite">{entries.length} {copy.count}</p>
      <footer className="ad-quick-switch-footer">
        <span><kbd>↑ ↓</kbd> {copy.navigate}</span><span><kbd>{"Enter"}</kbd> {copy.open}</span><span><kbd>{"Esc"}</kbd> {copy.dismiss}</span>
      </footer>
      {(filesLimited || groups.reduce((count, group) => count + group.entries.length, 0) > 60) && <p className="ad-quick-switch-limit">{copy.limited}</p>}
    </dialog>, document.body)}
  </>;
}
