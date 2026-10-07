const pt = {
  title: "Central de agentes", subtitle: "Acompanhe cada sessão, tarefa e subagente em um só lugar.",
  eyebrow: "CONTROLE DE OPERAÇÕES", sessions: "Sessões", working: "Em atividade", attention: "Precisam de atenção", subagents: "Subagentes",
  search: "Buscar agente, tarefa ou projeto…", allProviders: "Todas as IAs", all: "Todos", completed: "Concluídos",
  refresh: "Atualizar atividades", close: "Fechar central de agentes", openChat: "Abrir conversa", root: "Agente principal",
  activity: "Atividade recente", task: "Tarefa atual", message: "Última mensagem", details: "Detalhes", tools: "ferramentas",
  workspace: "Projeto", model: "Modelo", directory: "Diretório de trabalho", nativeId: "ID nativo", process: "Processo",
  files: "Arquivos alterados", updated: "Atualizado", noTask: "Aguardando a primeira tarefa desta sessão.",
  noMessage: "As mensagens aparecerão quando o agente responder.", noEvents: "Os comandos e ferramentas aparecerão aqui conforme o agente trabalhar.",
  noSessions: "Seu próximo trabalho começa com um agente.", noSessionsDetail: "Crie uma sessão no projeto para acompanhar tarefas, ferramentas e subagentes aqui.",
  noResults: "Nenhum agente corresponde aos filtros.", clear: "Limpar filtros", unbound: "Aguardando o ID da sessão nativa para descobrir subagentes.",
  unavailable: "O provedor ainda não disponibilizou um histórico local desta sessão.", unsupported: "Este provedor ainda não disponibiliza subagentes neste painel.",
  noSubagents: "Nenhum subagente foi registrado nesta sessão.", history: "Último estado registrado no histórico nativo.",
  live: "Eventos da sessão", native: "Histórico do provedor", localOnly: "Atualização automática a cada 8 segundos enquanto esta tela está visível.",
  recentOnly: "Exibindo o trecho recente do histórico para manter o painel rápido.", loadError: "Não foi possível atualizar os agentes.",
  browser: "O monitor de processos e subagentes fica disponível no aplicativo desktop.", lastActivity: "Última atividade", justNow: "agora", minutes: "min atrás",
  toolRunning: "Em execução", toolCompleted: "Concluída", toolFailed: "Falhou", toolStopped: "Interrompida", toolsLabel: "Ferramentas recentes", eventsLabel: "Eventos de execução", childOf: "Subagente de", showDetails: "Ver detalhes do agente",
};
type Messages = { [Key in keyof typeof pt]: string };
const en: Messages = {
  title: "Agent center", subtitle: "Follow every session, task and subagent in one place.",
  eyebrow: "OPERATIONS CONTROL", sessions: "Sessions", working: "Working", attention: "Need attention", subagents: "Subagents",
  search: "Search agents, tasks or projects…", allProviders: "All providers", all: "All", completed: "Completed",
  refresh: "Refresh activity", close: "Close agent center", openChat: "Open conversation", root: "Main agent",
  activity: "Recent activity", task: "Current task", message: "Latest message", details: "Details", tools: "tools",
  workspace: "Project", model: "Model", directory: "Working directory", nativeId: "Native ID", process: "Process",
  files: "Changed files", updated: "Updated", noTask: "Waiting for the first task in this session.",
  noMessage: "Messages will appear when the agent responds.", noEvents: "Commands and tools will appear here as the agent works.",
  noSessions: "Your next task starts with an agent.", noSessionsDetail: "Create a session in your project to follow tasks, tools and subagents here.",
  noResults: "No agents match these filters.", clear: "Clear filters", unbound: "Waiting for the native session ID to discover subagents.",
  unavailable: "The provider has not made a local transcript available for this session yet.", unsupported: "This provider does not expose subagents in this panel yet.",
  noSubagents: "No subagents have been recorded in this session.", history: "Last state recorded in the native transcript.",
  live: "Session events", native: "Provider transcript", localOnly: "Refreshes automatically every 8 seconds while this screen is visible.",
  recentOnly: "Showing recent history to keep the monitor responsive.", loadError: "Could not refresh agents.",
  browser: "Process and subagent monitoring is available in the desktop app.", lastActivity: "Last activity", justNow: "now", minutes: "min ago",
  toolRunning: "Running", toolCompleted: "Completed", toolFailed: "Failed", toolStopped: "Stopped", toolsLabel: "Recent tools", eventsLabel: "Execution events", childOf: "Subagent of", showDetails: "View agent details",
};
const es: Messages = {
  title: "Central de agentes", subtitle: "Sigue cada sesión, tarea y subagente en un solo lugar.",
  eyebrow: "CONTROL DE OPERACIONES", sessions: "Sesiones", working: "En actividad", attention: "Requieren atención", subagents: "Subagentes",
  search: "Buscar agente, tarea o proyecto…", allProviders: "Todas las IA", all: "Todos", completed: "Completados",
  refresh: "Actualizar actividad", close: "Cerrar central de agentes", openChat: "Abrir conversación", root: "Agente principal",
  activity: "Actividad reciente", task: "Tarea actual", message: "Último mensaje", details: "Detalles", tools: "herramientas",
  workspace: "Proyecto", model: "Modelo", directory: "Directorio de trabajo", nativeId: "ID nativo", process: "Proceso",
  files: "Archivos modificados", updated: "Actualizado", noTask: "Esperando la primera tarea de esta sesión.",
  noMessage: "Los mensajes aparecerán cuando el agente responda.", noEvents: "Los comandos y herramientas aparecerán aquí cuando el agente trabaje.",
  noSessions: "Tu próxima tarea comienza con un agente.", noSessionsDetail: "Crea una sesión en tu proyecto para seguir tareas, herramientas y subagentes aquí.",
  noResults: "Ningún agente coincide con los filtros.", clear: "Limpiar filtros", unbound: "Esperando el ID de la sesión nativa para descubrir subagentes.",
  unavailable: "El proveedor todavía no ha puesto a disposición un historial local de esta sesión.", unsupported: "Este proveedor aún no ofrece subagentes en este panel.",
  noSubagents: "No se han registrado subagentes en esta sesión.", history: "Último estado registrado en el historial nativo.",
  live: "Eventos de sesión", native: "Historial del proveedor", localOnly: "Se actualiza cada 8 segundos mientras esta pantalla está visible.",
  recentOnly: "Se muestra el historial reciente para mantener la rapidez del panel.", loadError: "No se pudieron actualizar los agentes.",
  browser: "El monitor de procesos y subagentes está disponible en la aplicación de escritorio.", lastActivity: "Última actividad", justNow: "ahora", minutes: "min atrás",
  toolRunning: "En ejecución", toolCompleted: "Completada", toolFailed: "Falló", toolStopped: "Interrumpida", toolsLabel: "Herramientas recientes", eventsLabel: "Eventos de ejecución", childOf: "Subagente de", showDetails: "Ver detalles del agente",
};

export function agentMonitorMessages(locale: string): Messages {
  return locale.startsWith("pt") ? pt : locale.startsWith("es") ? es : en;
}

export function agentPhaseLabel(status: string, locale: string) {
  const phases: Record<string, [string, string, string]> = {
    idle: ["Pronto", "Ready", "Listo"], starting: ["Iniciando", "Starting", "Iniciando"], connected: ["Conectado", "Connected", "Conectado"],
    running: ["Em atividade", "Working", "En actividad"], waiting: ["Aguardando resposta", "Waiting for input", "Esperando respuesta"],
    done: ["Concluído", "Completed", "Completado"], stopped: ["Interrompido", "Stopped", "Interrumpido"],
    suspended: ["Suspenso", "Suspended", "Suspendido"], error: ["Erro", "Error", "Error"], unknown: ["Histórico disponível", "History available", "Historial disponible"],
  };
  return (phases[status] ?? phases.unknown)[locale.startsWith("pt") ? 0 : locale.startsWith("es") ? 2 : 1];
}
