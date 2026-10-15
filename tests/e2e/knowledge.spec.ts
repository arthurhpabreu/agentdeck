import { expect, test, type Page } from "@playwright/test";

async function setupDocuments(page: Page, checkInitialTab = false) {
  await page.addInitScript(() => {
    const w = window as any; let nextId = 0;
    w.__documentCalls = []; w.__cancelPick = false; w.__searchFailure = false; w.__sourceFailure = false; w.__holdSearch = false;
    w.__vaults = [{id:"a",name:"QA vault",path:"C:\\Notes",mode:"automatic",allowedPaths:[]}];
    w.__projectSelection = {sourceIds:[],personalPreferences:false,memoryCollectionIds:[]}; w.__customSelections={};w.__policyRevision=1;
    w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
    w.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "popup" }, currentWebview: { label: "popup" } }, transformCallback: () => ++nextId, unregisterCallback: () => {},
      invoke: async (command: string, args: any = {}) => {
        w.__documentCalls.push({ command, args });
        const custom = args.sessionId ? w.__customSelections[args.sessionId] : undefined;
        const selection = custom ?? (args.projectPath ? w.__projectSelection : {sourceIds:[],personalPreferences:false,memoryCollectionIds:[]});
        const sources=w.__vaults.filter((vault:any)=>selection.sourceIds.includes(vault.id));
        const policy=()=>({schemaVersion:2,revision:w.__policyRevision,projectKey:args.projectPath??null,sessionId:args.sessionId??null,inheritProject:!custom,selection,vaults:w.__vaults,selectedSources:sources,memoryCollections:[],missingSourceIds:selection.sourceIds.filter((id:string)=>!w.__vaults.some((vault:any)=>vault.id===id)),migrationBackup:null});
        if(command==="get_source_policy")return policy();
        if(command==="set_project_source_policy"){w.__projectSelection=args.selection;w.__policyRevision++;return policy();}
        if(command==="set_conversation_source_policy"){if(args.selection===null)delete w.__customSelections[args.sessionId];else w.__customSelections[args.sessionId]=args.selection;w.__policyRevision++;return policy();}
        if(command==="save_knowledge_vault"){if(w.__sourceFailure)throw new Error("Source unavailable");const vault={...args.vault,id:args.vault.id||`vault-${w.__vaults.length}`};w.__vaults=w.__vaults.filter((existing:any)=>existing.id!==vault.id).concat(vault);w.__policyRevision++;return vault;}
        if(command==="remove_knowledge_vault"){w.__vaults=w.__vaults.filter((vault:any)=>vault.id!==args.sourceId);w.__policyRevision++;return;}
        if(command==="get_knowledge_health"){
          if(w.__healthFailure)throw new Error("QA health check unavailable");
          const source=w.__vaults.find((vault:any)=>vault.id===(args.sourceId??sources[0]?.id));
          return {sourcePath:source?.path??"",status:source?(w.__healthStatus??"ready"):"none",noteCount:source?(w.__healthNoteCount??2):0,checkedAt:Date.now(),maxNotes:3000,maxIndexBytes:16777216,maxNoteBytes:1048576,diagnostics:w.__healthDiagnostics??null,message:w.__healthMessage??""};
        }
        if(command==="pick_folder")return w.__cancelPick?null:"C:\\Notes\\Extra";
        if(command==="get_knowledge_graph")return sources.length||args.sourceId?w.__graph??{nodes:[{path:"decisions.md",title:"Project decisions",links:1},{path:"architecture.md",title:"Architecture",links:1}],edges:[{source:"decisions.md",target:"architecture.md"}],noteCount:2,linkCount:1,truncated:false,indexLimited:false}:{nodes:[],edges:[],noteCount:0,linkCount:0,truncated:false,indexLimited:false};
        if(command==="read_knowledge_note")return {path:args.path,title:args.path==="decisions.md"?"Project decisions":"Architecture",excerpt:`Preview from ${args.projectPath??"catalog"}: ${args.path}`,score:0};
        if(command==="search_knowledge"){
          if(w.__holdSearch)await new Promise<void>(resolve=>{w.__releaseSearch=resolve;});if(w.__searchFailure)throw new Error("Search temporarily unavailable");
          return args.query==="none"||(!sources.length&&!args.sourceId)?[]:[{path:"decisions.md",title:"Project decisions",excerpt:"Decisions use typed results and project scope.",score:1}];
        }
        if(command==="memory_status")return {enabled:true,captureEnabled:true,budgetTokens:800,recordCount:0,projectKey:args.projectPath,storage:"local",retrieval:"fts5",estimatedTokenMethod:"bytes/4"};
        if(command==="get_git_status")return {staged:[],unstaged:[],untracked:[],conflicts:[],committed:[]};
        if(command==="plugin:window|outer_size")return {width:1360,height:900};if(command==="plugin:window|outer_position")return {x:0,y:0};if(command==="plugin:window|scale_factor")return 1;
        if(command==="check_cli")return true;if(command==="plugin:event|listen")return ++nextId;
        if(["get_provider_usage","memory_list","recover_workspace_sessions","backfill_workspace_session_bindings","list_agent_models"].includes(command)||command.startsWith("get_git_diff"))return [];
        if(command==="load_ui_states"||command==="load_deleted_ui_state")return {};return null;
      },
    };
    localStorage.setItem("agentdeck-settings",JSON.stringify({state:{settings:{locale:"pt-BR",theme:"dark",splitWidgetPanelCollapsed:true,splitPaneSidebarWidth:380,runner:{type:"codex"}}},version:0}));
    localStorage.setItem("agentdeck-workspaces",JSON.stringify({state:{workspaces:[{id:"alpha",name:"Alpha",path:"C:\\Projects\\Alpha",color:"green",createdAt:1,order:0}],activeWorkspaceId:"alpha"},version:0}));
    localStorage.setItem("agentdeck-sessions",JSON.stringify({state:{sessions:[{id:"doc-session",name:"Documents",workspaceId:"alpha",workdir:"C:\\Projects\\Alpha",status:"idle",currentTask:"",createdAt:1,diffFiles:[],output:[],runner:{type:"codex"}}],activeSessionId:"doc-session"},version:0}));
  });
  await page.goto("/");await page.getByRole("button",{name:"Conhecimento local",exact:true}).click();if(checkInitialTab)await expect(page.getByRole("tab",{name:"Documentos",exact:true})).toHaveAttribute("aria-selected","true");await page.getByRole("tab",{name:"Documentos",exact:true}).click();return page.locator(".ad-documents");
}
async function selectVault(page:Page,docs:ReturnType<Page["locator"]>){await docs.getByRole("checkbox",{name:"Selecionado: QA vault",exact:true}).check();await docs.locator(".ad-documents-explore > summary").click();await docs.locator(".ad-documents-diagnostics > summary").click();await expect(docs.getByRole("region",{name:"Saúde da fonte",exact:true})).toContainText(/2\s+notas|Índice parcial|Pasta indisponível/);}
const globalScope=(page:Page)=>page.getByRole("group",{name:"Navegação de documentos"}).getByRole("button",{name:"Catálogo",exact:true});

test("new knowledge panels start with documents and retain the chosen tab when reopened",async({page})=>{
  await setupDocuments(page,true);
  await expect(page.getByRole("tab",{name:"Documentos",exact:true})).toHaveAttribute("aria-selected","true");
  await page.getByRole("tab",{name:"Memória compartilhada",exact:true}).click();
  await page.getByTestId("workbench-sidebar").getByRole("button",{name:"Arquivos",exact:true}).click();
  await page.getByRole("button",{name:"Conhecimento local",exact:true}).click();
  await expect(page.getByRole("tab",{name:"Memória compartilhada",exact:true})).toHaveAttribute("aria-selected","true");
  await page.getByRole("tab",{name:"Memória compartilhada",exact:true}).focus();await page.keyboard.press("Home");
  await expect(page.getByRole("tab",{name:"Documentos",exact:true})).toBeFocused();
  await page.keyboard.press("End");
  await expect(page.getByRole("tab",{name:"Memória compartilhada",exact:true})).toBeFocused();
});

test("document hierarchy makes conversation selection explicit and opens exploration on request @macos",async({page})=>{
  const docs=await setupDocuments(page);
  await expect(page.getByRole("heading",{name:"Fontes da conversa",exact:true})).toBeVisible();
  await expect(page.locator(".ad-documents-context")).toHaveText("ConversaDocuments");
  await expect(page.locator(".ad-memory-project select")).toHaveValue("alpha");
  await expect(docs.locator(".ad-source-count").first()).toHaveText("Selecionados: 0");
  await expect(docs.getByRole("region",{name:"Grafo de notas",exact:true})).toHaveCount(0);
  await expect(docs.getByRole("region",{name:"Saúde da fonte",exact:true})).toHaveCount(0);
  await docs.getByRole("checkbox",{name:"Selecionado: QA vault",exact:true}).check();
  await expect(docs.locator(".ad-source-count").first()).toHaveText("Selecionados: 1");
  const calls=await page.evaluate(()=>(window as any).__documentCalls);
  expect(calls.some((call:any)=>["get_knowledge_graph","get_knowledge_health"].includes(call.command))).toBe(false);
  await globalScope(page).click();
  await expect(page.getByText("Cadastrar um vault não ativa seu uso em projetos ou conversas.",{exact:true})).toBeVisible();
  const search=docs.getByRole("textbox",{name:"Buscar",exact:true});
  await expect(search).toBeDisabled();
  await docs.getByRole("button",{name:"Consultar notas",exact:true}).click();
  await expect(docs.locator(".ad-documents-inspector")).toContainText("QA vault");
  await search.fill("catalog inspection");await search.press("Enter");
  await expect(docs.locator(".ad-documents-results")).toBeVisible();
  const searches=await page.evaluate(()=>(window as any).__documentCalls.filter((call:any)=>call.command==="search_knowledge"));
  expect(searches.at(-1).args).toMatchObject({projectPath:null,sessionId:null,sourceId:"a"});
  await docs.getByRole("button",{name:"Fechar consulta do vault",exact:true}).click();
  await expect(search).toBeDisabled();
  expect(await page.evaluate(()=>(window as any).__customSelections["doc-session"].sourceIds)).toEqual(["a"]);
});

test("vault registration does not grant any project; custom empty blocks inherited sources @macos",async({page})=>{
  const docs=await setupDocuments(page);await expect(docs).toContainText("Nenhum vault será consultado.");
  const projectDefaults=docs.locator(".ad-project-source-defaults");await projectDefaults.locator(":scope > summary").click();await projectDefaults.getByRole("checkbox",{name:"Selecionado: QA vault",exact:true}).check();await projectDefaults.locator(":scope > summary").click();
  await expect(docs.getByRole("combobox",{name:"Vaults selecionados",exact:true})).toHaveValue("inherit");await expect(docs.getByRole("checkbox",{name:"Selecionado: QA vault",exact:true})).toBeChecked();await docs.getByRole("combobox",{name:"Vaults selecionados",exact:true}).selectOption("custom");
  await docs.getByRole("checkbox",{name:"Selecionado: QA vault",exact:true}).uncheck();await expect(docs).toContainText("Nenhum vault será consultado.");
  await expect(docs.getByRole("combobox",{name:"Vaults selecionados",exact:true})).toHaveValue("custom");
  expect(await page.evaluate(()=>(window as any).__projectSelection.sourceIds)).toEqual(["a"]);
  await globalScope(page).click();await docs.getByRole("button",{name:"Cadastrar vault",exact:true}).click();
  const editor=docs.locator(".ad-source-editor");await editor.getByRole("textbox",{name:"Nome",exact:true}).fill("Arbitrary FPS vault");
  await page.evaluate(()=>{(window as any).__cancelPick=true;});await editor.getByRole("button",{name:"Escolher pasta",exact:true}).click();await expect(editor.getByRole("textbox",{name:"Pasta",exact:true})).toHaveValue("");
  await page.evaluate(()=>{(window as any).__cancelPick=false;});await editor.getByRole("button",{name:"Escolher pasta",exact:true}).click();await editor.locator("summary").click();await editor.getByRole("combobox",{name:"Modo",exact:true}).selectOption("query");await editor.getByRole("textbox",{name:/Pastas ou notas autorizadas/}).fill("News\nGuides");await editor.getByRole("button",{name:"Salvar",exact:true}).click();
  await expect(docs).toContainText("Arbitrary FPS vault");expect(await page.evaluate(()=>(window as any).__projectSelection.sourceIds)).toEqual(["a"]);
});
test("search cancellation and retry preserve the query and discard superseded responses",async({page})=>{
  const docs=await setupDocuments(page);await selectVault(page,docs);const input=docs.getByRole("textbox",{name:"Buscar",exact:true});
  await input.fill("first");await page.evaluate(()=>{(window as any).__holdSearch=true;});await input.press("Enter");await input.fill("second");
  await page.evaluate(()=>{(window as any).__holdSearch=false;(window as any).__releaseSearch();});await expect(docs.locator(".ad-documents-results summary")).toHaveCount(0);
  await page.evaluate(()=>{(window as any).__searchFailure=true;});await input.press("Enter");await expect(docs.getByRole("alert")).toContainText("Search temporarily unavailable");await page.evaluate(()=>{(window as any).__searchFailure=false;});await docs.getByRole("button",{name:"Tentar novamente",exact:true}).click();await docs.locator(".ad-documents-results summary").click();await expect(docs).toContainText("Decisions use typed results");
  await input.fill("none");await input.press("Enter");await expect(docs).toContainText("Nenhuma nota encontrada para esta busca.");
});
test("catalog write failure retains editable draft for retry and removal never deletes notes",async({page})=>{
  const docs=await setupDocuments(page);await globalScope(page).click();await docs.locator(".ad-source-row-options > summary").click();await docs.getByRole("button",{name:"Editar",exact:true}).click();const editor=docs.locator(".ad-source-editor");await editor.getByRole("textbox",{name:"Nome",exact:true}).fill("Renamed vault");await page.evaluate(()=>{(window as any).__sourceFailure=true;});await editor.getByRole("button",{name:"Salvar",exact:true}).click();await expect(docs.getByRole("alert")).toContainText("Source unavailable");await expect(editor.getByRole("textbox",{name:"Nome",exact:true})).toHaveValue("Renamed vault");await page.evaluate(()=>{(window as any).__sourceFailure=false;});await editor.getByRole("button",{name:"Salvar",exact:true}).click();await expect(docs).toContainText("Renamed vault");await docs.getByRole("button",{name:"Remover associação",exact:true}).click();await expect(docs.getByText("Renamed vault",{exact:true})).toHaveCount(0);
  const calls=await page.evaluate(()=>(window as any).__documentCalls);expect(calls.some((call:any)=>/delete.*(file|folder)|remove_directory/.test(call.command))).toBe(false);
});
test("graph navigation reads connected notes without requesting a model",async({page})=>{
  const docs=await setupDocuments(page);await selectVault(page,docs);const graph=docs.getByRole("region",{name:"Grafo de notas",exact:true});await graph.getByRole("combobox",{name:"Selecionar nota",exact:true}).selectOption("decisions.md");await expect(graph.getByLabel("Trecho da nota")).toContainText("decisions.md");await graph.getByRole("button",{name:"Architecture",exact:true}).click();await expect(graph.getByLabel("Trecho da nota")).toContainText("architecture.md");await graph.getByRole("button",{name:"Atualizar índice",exact:true}).click();const calls=await page.evaluate(()=>(window as any).__documentCalls);expect(calls.some((call:any)=>call.command==="get_knowledge_graph"&&call.args.refresh===true)).toBe(true);expect(calls.some((call:any)=>call.command==="start_chat_turn")).toBe(false);
});
test("expanded graph explores a large vault and restores keyboard focus",async({page})=>{
  const docs=await setupDocuments(page);await page.evaluate(()=>{const nodes=Array.from({length:1600},(_,i)=>({path:`folder-${i%8}/note-${i}.md`,title:`Note ${i}`,links:2}));(window as any).__graph={nodes,edges:nodes.map((node,i)=>({source:node.path,target:nodes[(i+1)%nodes.length].path})),noteCount:nodes.length,linkCount:nodes.length,truncated:false,indexLimited:false};});await selectVault(page,docs);const expand=docs.getByRole("button",{name:"Expandir grafo",exact:true});await expand.click();const dialog=page.getByRole("dialog",{name:"Grafo de notas",exact:true});await expect(dialog.locator(".ad-knowledge-folder")).toHaveCount(8);await dialog.getByRole("button",{name:"folder-7 · 200 notas",exact:true}).click();await expect(dialog.locator(".ad-note-graph-node")).toHaveCount(200);await dialog.getByRole("combobox",{name:"Filtrar por pasta"}).selectOption("*");await expect(dialog.locator(".ad-note-graph-node")).toHaveCount(350);await dialog.getByRole("searchbox",{name:"Buscar nota no grafo"}).fill("Note 1599");await dialog.getByRole("button",{name:"Note 1599 · 2 ligações",exact:true}).click();await expect(dialog.getByLabel("Trecho da nota")).toContainText("note-1599.md");await page.keyboard.press("Escape");await expect(dialog).toHaveCount(0);await expect(expand).toBeFocused();
});
test("vault health rechecks unavailable and limited sources without changing associations",async({page})=>{
  const docs=await setupDocuments(page);await page.evaluate(()=>{const w=window as any;w.__healthStatus="unavailable";w.__healthNoteCount=0;});await selectVault(page,docs);const health=docs.getByRole("region",{name:"Saúde da fonte",exact:true});await expect(health.getByRole("alert")).toContainText("Pasta indisponível");await page.evaluate(()=>{const w=window as any;w.__healthStatus="limited";w.__healthNoteCount=3000;});await health.getByRole("button",{name:"Verificar fonte",exact:true}).click();await expect(health).toContainText("16 MiB");await expect(health.getByRole("alert")).toContainText("Índice parcial");await page.evaluate(()=>{(window as any).__healthFailure=true;});await health.getByRole("button",{name:"Verificar fonte",exact:true}).click();await expect(health).toContainText("QA health check unavailable");await page.evaluate(()=>{const w=window as any;w.__healthFailure=false;w.__healthStatus="ready";w.__healthNoteCount=2;});await health.getByRole("button",{name:"Verificar fonte",exact:true}).click();await expect(health.getByRole("alert")).toHaveCount(0);const calls=await page.evaluate(()=>(window as any).__documentCalls);expect(calls.filter((call:any)=>call.command==="set_conversation_source_policy")).toHaveLength(1);
});
test("vault diagnostics distinguish truncation from unreadable files",async({page})=>{
  const docs=await setupDocuments(page);await page.evaluate(()=>{const w=window as any;w.__healthStatus="limited";w.__healthDiagnostics={indexedNoteCount:2,indexedBytes:10000,noteLimitReached:false,indexByteLimitReached:false,truncatedNoteCount:6,unreadableFileCount:0,unreadableDirectoryCount:0,depthLimitReached:false,maxNotes:3000,maxIndexBytes:16777216,maxNoteBytes:1048576,maxDepth:32};});await selectVault(page,docs);const health=docs.getByRole("region",{name:"Saúde da fonte",exact:true});await expect(health).toContainText("Notas com texto truncado: 6");await page.evaluate(()=>{const d=(window as any).__healthDiagnostics;d.truncatedNoteCount=0;d.unreadableFileCount=2;});await health.getByRole("button",{name:"Verificar fonte",exact:true}).click();await expect(health).toContainText("Arquivos que não puderam ser lidos: 2.");await expect(health).not.toContainText("Notas com texto truncado");
});
test("closing the open conversation changes the visible project policy without carrying its session grant",async({page})=>{
  const docs=await setupDocuments(page);await selectVault(page,docs);await page.evaluate(async()=>{const path="/src/store/workspaceStore.ts";const store=(await import(/* @vite-ignore */path)).useWorkspaceStore;store.setState((state:any)=>({workspaces:[...state.workspaces,{id:"beta",name:"Other environment",path:"C:\\Projects\\Beta",color:"red",createdAt:2,order:1}],activeWorkspaceId:"beta"}));});await expect(page.locator(".ad-memory-project select")).toHaveValue("beta");await expect(page.locator(".ad-memory-project select")).toBeEnabled();await docs.getByRole("textbox",{name:"Buscar",exact:true}).fill("scope");await docs.getByRole("textbox",{name:"Buscar",exact:true}).press("Enter");await expect(docs.locator(".ad-documents-results")).toBeVisible();const calls=await page.evaluate(()=>(window as any).__documentCalls.filter((call:any)=>call.command==="search_knowledge"));expect(calls[calls.length-1].args).toMatchObject({projectPath:"C:\\Projects\\Beta",sessionId:null});
});
test("documents and memory retain matching scope controls in dark and light themes",async({page})=>{
  await setupDocuments(page);for(const theme of["dark","light"]){await page.evaluate(async theme=>{const path="/src/store/settingsStore.ts";(await import(/* @vite-ignore */path)).useSettingsStore.getState().patchSettings({theme});},theme);const style=()=>page.locator(".ad-memory-scopes").evaluate(element=>({padding:getComputedStyle(element).padding,border:getComputedStyle(element).border}));const documents=await style();await page.getByRole("tab",{name:"Memória compartilhada",exact:true}).click();expect(await style()).toEqual(documents);await expect(page.locator(".ad-memory-project select")).toHaveValue("alpha");await page.getByRole("tab",{name:"Documentos",exact:true}).click();}
});
