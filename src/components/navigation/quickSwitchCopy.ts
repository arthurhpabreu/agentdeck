const en = {
  trigger: "Go to…", title: "Quick navigation", search: "Search conversations, projects or actions", close: "Close navigation",
  clear: "Clear search", actions: "Actions", project: "Project", conversations: "conversations", current: "Current",
  agents: "Agents", agentsHint: "View activity and subagents", knowledge: "Local knowledge", knowledgeHint: "Open shared memory and documents",
  settings: "Settings", settingsHint: "Adjust your workspace", empty: "No matching results", emptyHint: "Try a conversation name, project or folder path.",
  navigate: "Navigate", open: "Open", dismiss: "Close", count: "results", limited: "Showing the first 60 matches. Refine your search.",
};
type Copy = { [Key in keyof typeof en]: string };
const pt: Copy = {
  trigger: "Ir para…", title: "Navegação rápida", search: "Buscar conversas, projetos ou ações", close: "Fechar navegação",
  clear: "Limpar busca", actions: "Ações", project: "Projeto", conversations: "conversas", current: "Atual",
  agents: "Agentes", agentsHint: "Ver atividade e subagentes", knowledge: "Conhecimento local", knowledgeHint: "Abrir memória compartilhada e documentos",
  settings: "Configurações", settingsHint: "Ajustar seu ambiente", empty: "Nenhum resultado encontrado", emptyHint: "Tente o nome da conversa, do projeto ou o caminho da pasta.",
  navigate: "Navegar", open: "Abrir", dismiss: "Fechar", count: "resultados", limited: "Exibindo os primeiros 60 resultados. Refine sua busca.",
};
const es: Copy = {
  trigger: "Ir a…", title: "Navegación rápida", search: "Buscar conversaciones, proyectos o acciones", close: "Cerrar navegación",
  clear: "Borrar búsqueda", actions: "Acciones", project: "Proyecto", conversations: "conversaciones", current: "Actual",
  agents: "Agentes", agentsHint: "Ver actividad y subagentes", knowledge: "Conocimiento local", knowledgeHint: "Abrir memoria compartida y documentos",
  settings: "Configuración", settingsHint: "Ajustar tu entorno", empty: "No se encontraron resultados", emptyHint: "Prueba el nombre de la conversación, del proyecto o la ruta de la carpeta.",
  navigate: "Navegar", open: "Abrir", dismiss: "Cerrar", count: "resultados", limited: "Se muestran los primeros 60 resultados. Refina la búsqueda.",
};
export function quickSwitchCopy(locale: string): Copy { return locale.startsWith("pt") ? pt : locale.startsWith("es") ? es : en; }
