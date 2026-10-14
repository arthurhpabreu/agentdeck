import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppI18n } from "../../i18n";
import { GLOBAL_MEMORY_KEY } from "../../services/memoryCommands";
import { useSharedMemoryStore } from "../../store/sharedMemoryStore";
export function curationCopy(locale:string) {
  const index=locale.startsWith("pt")?0:locale.startsWith("es")?2:1;
  const strings={
    title:["Seleção automática da memória","Automatic memory selection","Selección automática de memoria"],
    hint:["Regras locais mantêm a continuidade no projeto de origem. Preferências sugeridas aguardam aprovação explícita para alcance universal; nunca são compartilhadas automaticamente.","Local rules maintain continuity in the originating project. Suggested preferences await explicit universal approval; they are never shared automatically.","Las reglas locales mantienen la continuidad en el proyecto de origen. Las preferencias sugeridas requieren aprobación universal explícita y nunca se comparten automáticamente."],
    selected:["Selecionadas automaticamente","Automatically selected","Seleccionadas automáticamente"],
    archived:["Capturas arquivadas","Archived captures","Capturas archivadas"],
    conflicts:["Compartilhamento depende das preferências pessoais e coleções escolhidas nas fontes do projeto ou conversa. Notas manuais e fixadas são preservadas.","Sharing depends on personal preferences and collections explicitly selected for the project or conversation. Manual and pinned notes are preserved.","El uso compartido depende de las preferencias personales y colecciones elegidas para el proyecto o conversación. Se conservan las notas manuales y fijadas."],
    history:["Mostrar preferências já processadas","Show processed preferences","Mostrar preferencias ya procesadas"],
    automatic:["Selecionada automaticamente","Automatically selected","Seleccionada automáticamente"],
  };
  return Object.fromEntries(Object.entries(strings).map(([key,value])=>[key,value[index]])) as {[K in keyof typeof strings]:string};
}
interface Status {enabled:boolean;selected:number;archived:number;method:string}
export function MemoryCurationControl({path}:{path:string}) {
  const {locale}=useAppI18n();const c=curationCopy(locale);
  const [status,setStatus]=useState<Status|null>(null),[busy,setBusy]=useState(false),[error,setError]=useState("");
  const args=path===GLOBAL_MEMORY_KEY?{projectPath:"",scope:"global"}:{projectPath:path,scope:"project"};
  useEffect(()=>{let alive=true;setStatus(null);void invoke<Status>("memory_curation_status",args).then(value=>{if(alive&&value&&typeof value.enabled==="boolean")setStatus(value);}).catch(e=>{if(alive)setError(String(e));});return()=>{alive=false;};},[path]);
  const change=async(enabled:boolean)=>{setBusy(true);setError("");try{setStatus(await invoke<Status>("memory_set_curation_enabled",{...args,enabled}));await useSharedMemoryStore.getState().load(path);}catch(e){setError(String(e));}finally{setBusy(false);}};
  return <aside className="ad-memory-curation"><label><input type="checkbox" role="switch" aria-label={c.title} checked={status?.enabled??true} disabled={busy||!status} onChange={e=>void change(e.target.checked)} /><strong>{c.title}</strong></label><p>{c.hint}</p>{status&&<small>{c.selected}: {status.selected} · {c.archived}: {status.archived}</small>}<p>{c.conflicts}</p>{error&&<p role="alert">{error}</p>}</aside>;
}
