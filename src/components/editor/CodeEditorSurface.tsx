import { useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { oneDark } from "@codemirror/theme-one-dark";
import { EditorView } from "@codemirror/view";
import { useSettingsStore } from "../../store/settingsStore";
import { useEditorLocationStore } from "../../store/editorLocationStore";
import { useChatStore, emptyThread } from "../../store/chatStore";
import { showSessionSurface } from "../../services/workbenchCommands";
import { useAppI18n } from "../../i18n";
import { improvementsCopy } from "../platformImprovementsCopy";

const retainedViews = new Map<string, { anchor: number; head: number; scrollTop: number }>();

const LIGHT_THEME = EditorView.theme({
  "&": {
    height: "100%",
    backgroundColor: "var(--ci-code-bg)",
    color: "var(--ci-text)",
  },
  ".cm-content": {
    caretColor: "var(--ci-accent)",
    fontFamily: "'JetBrains Mono', 'Fira Code', 'SF Mono', monospace",
  },
  ".cm-gutters": {
    backgroundColor: "var(--ci-surface)",
    color: "var(--ci-text-dim)",
    borderRight: "1px solid var(--ci-toolbar-border)",
  },
  ".cm-activeLine": {
    backgroundColor: "rgba(0,122,255,0.06)",
  },
  ".cm-activeLineGutter": {
    backgroundColor: "rgba(0,122,255,0.08)",
  },
});

const BASIC_SETUP = {
  lineNumbers: true,
  foldGutter: true,
  highlightActiveLine: true,
  highlightSelectionMatches: true,
};

function languageExtension(path: string) {
  const normalized = path.toLowerCase();
  if (normalized.endsWith(".json")) return json();
  if (normalized.endsWith(".md") || normalized.endsWith(".markdown")) return markdown();
  if (normalized.endsWith(".ts") || normalized.endsWith(".tsx") || normalized.endsWith(".js") || normalized.endsWith(".jsx") || normalized.endsWith(".mjs") || normalized.endsWith(".cjs")) {
    return javascript({ jsx: normalized.endsWith("x"), typescript: normalized.includes(".ts") });
  }
  return [];
}

export function CodeEditorSurface({
  path,
  value,
  onChange,
  readOnly = false,
  sessionId,
}: {
  path: string;
  value: string;
  onChange: (value: string) => void;
  readOnly?: boolean;
  sessionId?: string;
}) {
  const { locale } = useAppI18n(); const c = improvementsCopy(locale);
  const viewRef = useRef<EditorView | null>(null); const [selection, setSelection] = useState<{ text: string; from: number; to: number }>();
  const location = useEditorLocationStore(state => sessionId ? state.locations[sessionId] : undefined);
  const key = `${sessionId ?? "preview"}:${path}`;
  const reveal = (view: EditorView) => { if (location?.path !== path) return; const line = view.state.doc.line(Math.min(view.state.doc.lines, Math.max(1, location.line))); view.dispatch({ selection: { anchor: line.from }, effects: EditorView.scrollIntoView(line.from, { y: "center" }) }); };
  useEffect(() => { if (viewRef.current) reveal(viewRef.current); }, [location?.revision, path]);
  useEffect(() => () => { const view = viewRef.current; if (view) { const selection = view.state.selection.main; retainedViews.set(key, { anchor: selection.anchor, head: selection.head, scrollTop: view.scrollDOM.scrollTop }); viewRef.current = null; } }, [key]);
  const themeMode = useSettingsStore((s) => s.settings.theme);
  const extensions = useMemo(() => {
    const language = languageExtension(path);
    const base = [EditorView.lineWrapping, EditorView.editable.of(!readOnly)];
    return Array.isArray(language)
      ? [...base, ...language]
      : [...base, language];
  }, [path, readOnly]);
  const cmTheme = useMemo(() => {
    if (themeMode === "dark") return oneDark;
    return LIGHT_THEME;
  }, [themeMode]);

  return (
    <div className="ad-code-editor" style={{ position: "relative", flex: 1, minHeight: 0, background: "var(--ci-code-bg)", overflow: "hidden" }}>
      <CodeMirror
        value={value}
        height="100%"
        theme={cmTheme}
        extensions={extensions}
        basicSetup={BASIC_SETUP}
        onCreateEditor={view => { viewRef.current = view; const retained = retainedViews.get(key); if (retained) { view.dispatch({ selection: { anchor: Math.min(view.state.doc.length, retained.anchor), head: Math.min(view.state.doc.length, retained.head) } }); view.scrollDOM.scrollTop = retained.scrollTop; } reveal(view); }}
        onUpdate={update => { if (!update.selectionSet && !update.docChanged) return; const selected = update.state.selection.main; setSelection(selected.empty ? undefined : { text: update.state.sliceDoc(selected.from, Math.min(selected.to, selected.from + 32_000)), from: update.state.doc.lineAt(selected.from).number, to: update.state.doc.lineAt(selected.to).number }); }}
        onChange={onChange}
        editable={!readOnly}
        style={{ height: "100%", fontSize: 12 }}
      />
      {sessionId && selection && <button style={{ position: "absolute", right: 20, bottom: 20, zIndex: 3, background: "var(--ci-surface)" }} className="ad-button ad-button-ghost ad-editor-selection-context" onClick={() => { const thread = useChatStore.getState().threads[sessionId] ?? emptyThread; useChatStore.getState().patch(sessionId, { draft: [thread.draft, `File: ${JSON.stringify(path)}; lines ${selection.from}-${selection.to}\nSelected code (quoted${selection.text.length === 32_000 ? "; excerpt limited to 32000 characters" : ""}):\n${JSON.stringify(selection.text)}`].filter(Boolean).join("\n\n") }); showSessionSurface(sessionId); }}>{c.selectedContext}</button>}
    </div>
  );
}
