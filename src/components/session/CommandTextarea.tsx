import { useEffect, useId, useLayoutEffect, useRef, useState, type RefObject, type TextareaHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { RefreshCw, Search, Slash, Sparkles, TerminalSquare, X } from "lucide-react";
import { useAppI18n } from "../../i18n";
import type { RunnerConfig } from "../../store/settingsStore";
import { useCliUpdateStore } from "../../store/cliUpdateStore";
import { commandToken, fallbackCommands, loadAgentCommands, type AgentCatalogue, type AgentCommand } from "../../services/agentCommands";
import { commandCopy } from "./commandCopy";
import "./commands.css";

type Filter = "all" | "command" | "skill";
interface Props extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value" | "onChange"> {
  value: string; onValueChange: (value: string) => void; runner: RunnerConfig; workdir: string; projectPath?: string;
  inputRef?: RefObject<HTMLTextAreaElement | null>; native?: boolean; visible?: boolean;
  browse?: { revision: number; filter: Filter }; onCatalogue?: (value: AgentCatalogue) => void;
}
export function CommandTextarea({ value, onValueChange, runner, workdir, projectPath = workdir, inputRef, native = false, visible = true, browse, onCatalogue, onKeyDown, onSelect, onFocus, onBlur, ...props }: Props) {
  const { locale } = useAppI18n(); const c = commandCopy(locale);
  const internal = useRef<HTMLTextAreaElement>(null); const ref = inputRef ?? internal;
  const id = useId(); const popup = useRef<HTMLDivElement>(null); const generation = useRef(0);
  const callback = useRef(onCatalogue); callback.current = onCatalogue;
  const [catalogue, setCatalogue] = useState<AgentCatalogue>({ entries: fallbackCommands(runner), warnings: [] });
  const [loading, setLoading] = useState(false); const [focused, setFocused] = useState(false);
  const [caret, setCaret] = useState(value.length); const [dismissed, setDismissed] = useState<string>();
  const [browsing, setBrowsing] = useState(false); const [filter, setFilter] = useState<Filter>("all");
  const [search, setSearch] = useState(""); const [active, setActive] = useState(0);
  const [position, setPosition] = useState({ left: 0, bottom: 0, width: 320, maxHeight: 360 });
  const revision = useCliUpdateStore(state => state.revision);
  const token = commandToken(value, caret);
  const signature = token ? `${token.start}:${token.prefix}:${token.query}` : undefined;
  const open = visible && !props.disabled && (browsing || focused && !!token && signature !== dismissed);
  const refresh = async (force = false) => {
    const current = ++generation.current; setLoading(true);
    try {
      const result = await loadAgentCommands(runner, workdir, projectPath, force);
      if (current === generation.current) { setCatalogue(result); callback.current?.(result); }
    } catch {
      if (current === generation.current) { const result = { entries: fallbackCommands(runner), warnings: ["cli_catalogue_unavailable"] }; setCatalogue(result); callback.current?.(result); }
    } finally { if (current === generation.current) setLoading(false); }
  };
  useEffect(() => { const fallback = { entries: fallbackCommands(runner), warnings: [] }; setCatalogue(fallback); callback.current?.(fallback); setBrowsing(false); setDismissed(undefined); void refresh(); return () => { generation.current++; }; }, [runner.type, runner.cliPath, workdir, projectPath, revision]);
  useEffect(() => { if (!visible) { setBrowsing(false); setFocused(false); } }, [visible]);
  useEffect(() => { if (browse) { setFilter(browse.filter); setSearch(""); setBrowsing(true); setDismissed(undefined); } }, [browse?.revision]);
  const close = () => { setBrowsing(false); setDismissed(signature); };
  const query = browsing ? search.toLocaleLowerCase() : token?.query ?? "";
  const entries = catalogue.entries.filter(entry => !(native && entry.kind === "builtin" && ["code", "effort"].includes(entry.name)) && (filter === "all" || (filter === "skill" ? entry.kind === "skill" : entry.kind !== "skill")) && (token?.prefix !== "$" || browsing || entry.kind === "skill") && `${entry.name} ${entry.invocation} ${entry.description}`.toLocaleLowerCase().includes(query)).sort((a, b) => Number(b.name.toLocaleLowerCase().startsWith(query)) - Number(a.name.toLocaleLowerCase().startsWith(query)) || a.name.localeCompare(b.name));
  useEffect(() => { setActive(0); }, [query, filter, catalogue, token?.prefix]);
  useLayoutEffect(() => {
    if (!open) return;
    const update = () => {
      const rect = ref.current?.getBoundingClientRect(); if (!rect) return;
      const top = Math.max(82, ref.current?.closest(".ad-chat, .ad-welcome")?.getBoundingClientRect().top ?? 82);
      const aboveSpace = rect.top - top; const belowSpace = innerHeight - rect.bottom - 8;
      const above = aboveSpace > 210 || aboveSpace > belowSpace && aboveSpace > 150;
      const height = Math.min(360, Math.max(120, (above ? aboveSpace : belowSpace) - 18));
      setPosition({ left: Math.max(8, Math.min(rect.left, innerWidth - Math.min(640, rect.width) - 8)), bottom: above ? innerHeight - rect.top + 8 : Math.max(8, innerHeight - rect.bottom - height - 8), width: Math.min(640, Math.max(280, Math.min(rect.width, innerWidth - 16))), maxHeight: height });
    };
    update(); window.addEventListener("resize", update); window.addEventListener("scroll", update, true);
    return () => { window.removeEventListener("resize", update); window.removeEventListener("scroll", update, true); };
  }, [open, value, browsing]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!popup.current?.contains(event.target as Node) && event.target !== ref.current) close(); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); ref.current?.focus(); } };
    document.addEventListener("pointerdown", outside); window.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", outside); window.removeEventListener("keydown", escape, true); };
  }, [open, signature]);
  useEffect(() => { if (open) document.getElementById(`${id}-${active}`)?.scrollIntoView({ block: "nearest" }); }, [active, open]);
  const select = (entry: AgentCommand) => {
    const currentCaret = ref.current?.selectionStart ?? caret;
    const currentToken = commandToken(value, currentCaret);
    const start = currentToken?.start ?? currentCaret;
    const end = currentToken?.end ?? currentCaret;
    const inserted = `${entry.invocation} `;
    onValueChange(value.slice(0, start) + inserted + value.slice(end));
    setBrowsing(false); setDismissed(undefined);
    requestAnimationFrame(() => { ref.current?.focus(); ref.current?.setSelectionRange(start + inserted.length, start + inserted.length); setCaret(start + inserted.length); });
  };
  const keyboard = (event: React.KeyboardEvent<HTMLElement>) => {
    if (!open || event.nativeEvent.isComposing) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); event.stopPropagation(); setActive(index => entries.length ? (index + (event.key === "ArrowDown" ? 1 : -1) + entries.length) % entries.length : 0); return true; }
    if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey && entries[active]) { event.preventDefault(); event.stopPropagation(); select(entries[active]); return true; }
    if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); return true; }
    return false;
  };
  return <div className="ad-command-input">
    <textarea {...props} ref={ref} value={value} role="combobox" aria-autocomplete="list" aria-expanded={open} aria-controls={open ? `${id}-list` : undefined} aria-activedescendant={open && entries[active] ? `${id}-${active}` : undefined} onChange={event => { setCaret(event.target.selectionStart); setDismissed(undefined); onValueChange(event.target.value); }} onSelect={event => { setCaret(event.currentTarget.selectionStart); onSelect?.(event); }} onFocus={event => { setFocused(true); setCaret(event.currentTarget.selectionStart); onFocus?.(event); }} onBlur={event => { setFocused(false); onBlur?.(event); }} onKeyDown={event => { if (!keyboard(event)) onKeyDown?.(event); }} />
    <div className="ad-command-shortcuts"><button type="button" disabled={props.disabled} title={c.helpHint} onClick={() => { setFilter("all"); setSearch(""); setBrowsing(true); }}><Slash size={12} />{c.commands}</button><button type="button" disabled={props.disabled} onClick={() => { setFilter("skill"); setSearch(""); setBrowsing(true); }}><Sparkles size={12} />{c.skills}</button></div>
    {open && createPortal(<div className="ad-command-picker" ref={popup} style={position} role="region" aria-label={c.title}>
      <header><strong><Slash size={14} />{c.title}</strong><button type="button" className="ad-icon-button" aria-label={c.refresh} disabled={loading} onClick={() => void refresh(true)}><RefreshCw size={14} className={loading ? "ad-spin" : ""} /></button><button type="button" className="ad-icon-button" aria-label={c.close} onClick={() => { close(); ref.current?.focus(); }}><X size={14} /></button></header>
      <div className="ad-command-filters">{(["all", "command", "skill"] as const).map(kind => <button type="button" key={kind} aria-pressed={filter === kind} onClick={() => setFilter(kind)}>{kind === "all" ? c.all : kind === "command" ? c.commands : c.skills}</button>)}</div>
      {browsing && <label className="ad-command-search"><Search size={14} /><input autoFocus aria-label={c.search} placeholder={c.search} value={search} onChange={event => setSearch(event.target.value)} onKeyDown={keyboard} /></label>}
      {loading && <p className="ad-command-feedback" role="status">{c.loading}</p>}
      {!!catalogue.warnings.length && <p className="ad-command-feedback" role="status">{catalogue.warnings.includes("cli_catalogue_unavailable") ? c.unavailable : c.limit}</p>}
      <div className="ad-command-list" id={`${id}-list`} role="listbox" aria-label={c.title}>{entries.map((entry, index) => <button type="button" className="ad-command-option" role="option" aria-selected={index === active} id={`${id}-${index}`} key={`${entry.invocation}:${entry.path ?? entry.source}`} onPointerDown={event => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => select(entry)} title={entry.path || entry.description}>
        {entry.kind === "skill" ? <Sparkles size={17} /> : <Slash size={17} />}<span><strong>{entry.invocation}{entry.argumentHint && <small> {entry.argumentHint}</small>}</strong>{entry.description && <em>{entry.description}</em>}<small>{c[entry.kind]} · {c[entry.source as "user"] || entry.source} {entry.transport === "native" && !native && !["help", "skills", "model", "effort", "fast", "plan", "code", "status"].includes(entry.name) && <>· <TerminalSquare size={10} /> {c.native}</>}</small></span>
      </button>)}{!entries.length && !loading && <p className="ad-command-feedback">{filter === "skill" ? c.noSkills : c.empty}</p>}</div><footer>{c.hint}<span>{entries.length}</span></footer>
    </div>, document.body)}
  </div>;
}
