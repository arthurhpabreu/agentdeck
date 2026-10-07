import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useAppI18n } from "../../i18n";
import { GLOBAL_MEMORY_KEY } from "../../services/memoryCommands";
import { useSharedMemoryStore } from "../../store/sharedMemoryStore";
export function curationCopy(locale:string) {
  const index=locale.startsWith("pt")?0:locale.startsWith("es")?2:1;
  const strings={
    title:["Seleção automática da memória","Automatic memory selection","Selección automática de memoria"],
    hint:["Regras locais selecionam preferências duráveis e mantêm um contexto por conversa. Capturas repetidas ficam no Arquivo; você não precisa revisar cada resposta.","Local rules select durable preferences and keep one context per conversation. Repeated captures remain in Archive; you do not need to review every response.","Reglas locales seleccionan preferencias duraderas y mantienen un contexto por conversación. Las capturas repetidas quedan en Archivo; no necesitas revisar cada respuesta."],
    selected:["Selecionadas automaticamente","Automatically selected","Seleccionadas automáticamente"],
    archived:["Capturas arquivadas","Archived captures","Capturas archivadas"],
    conflicts:["Preferências conflitantes ficam disponíveis para revisão opcional. Notas manuais e fixadas são preservadas.","Conflicting preferences remain available for optional review. Manual and pinned notes are preserved.","Las preferencias en conflicto quedan disponibles para revisión opcional. Las notas manuales y fijadas se conservan."],
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
