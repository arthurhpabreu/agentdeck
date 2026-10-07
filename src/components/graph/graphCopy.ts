const en = {
  expand: "Expand graph", close: "Close expanded graph", zoomIn: "Zoom in", zoomOut: "Zoom out", fit: "Fit graph",
  hint: "Drag to pan · Ctrl + scroll to zoom", overview: "Folders", notes: "Notes", neighborhood: "Connections",
  search: "Find a note in the graph", folder: "Filter by folder", allFolders: "All folders", rootFolder: "Root folder",
  labels: "Show labels", visible: "visible", shown: "Displayed notes", budget: "Node limit", empty: "No notes match these filters.",
  focusHint: "Select a note to explore its connections.", depth: "Connection depth", back: "All folders",
  map: "Flow map", list: "List", tasks: "Task board", pause: "Pause animations", resume: "Resume animations",
  delegation: "Delegation", execution: "Task execution", recorded: "Recorded state", mapHint: "Select an agent or task to inspect its activity.",
  waiting: "Ready / paused", running: "Working", attention: "Needs attention", completed: "Completed", task: "Task",
  limitHint: "Showing the most connected matches. Narrow the folder, search or connections to explore more.",
};
const pt: typeof en = {
  expand: "Expandir grafo", close: "Fechar grafo expandido", zoomIn: "Ampliar", zoomOut: "Reduzir", fit: "Ajustar à tela",
  hint: "Arraste para mover · Ctrl + rolagem para zoom", overview: "Pastas", notes: "Notas", neighborhood: "Conexões",
  search: "Buscar nota no grafo", folder: "Filtrar por pasta", allFolders: "Todas as pastas", rootFolder: "Pasta raiz",
  labels: "Mostrar títulos", visible: "visíveis", shown: "Notas exibidas", budget: "Limite de nós", empty: "Nenhuma nota corresponde aos filtros.",
  focusHint: "Selecione uma nota para explorar suas conexões.", depth: "Profundidade das conexões", back: "Todas as pastas",
  map: "Mapa de fluxos", list: "Lista", tasks: "Quadro de tarefas", pause: "Pausar animações", resume: "Retomar animações",
  delegation: "Delegação", execution: "Execução de tarefa", recorded: "Estado registrado", mapHint: "Selecione um agente ou tarefa para inspecionar sua atividade.",
  waiting: "Prontos / pausados", running: "Em atividade", attention: "Precisam de atenção", completed: "Concluídos", task: "Tarefa",
  limitHint: "Exibindo os resultados mais conectados. Refine a pasta, busca ou conexões para explorar mais.",
};
const es: typeof en = {
  expand: "Expandir grafo", close: "Cerrar grafo expandido", zoomIn: "Acercar", zoomOut: "Alejar", fit: "Ajustar a la pantalla",
  hint: "Arrastra para mover · Ctrl + rueda para zoom", overview: "Carpetas", notes: "Notas", neighborhood: "Conexiones",
  search: "Buscar nota en el grafo", folder: "Filtrar por carpeta", allFolders: "Todas las carpetas", rootFolder: "Carpeta raíz",
  labels: "Mostrar títulos", visible: "visibles", shown: "Notas mostradas", budget: "Límite de nodos", empty: "Ninguna nota coincide con los filtros.",
  focusHint: "Selecciona una nota para explorar sus conexiones.", depth: "Profundidad de conexiones", back: "Todas las carpetas",
  map: "Mapa de flujos", list: "Lista", tasks: "Tablero de tareas", pause: "Pausar animaciones", resume: "Reanudar animaciones",
  delegation: "Delegación", execution: "Ejecución de tarea", recorded: "Estado registrado", mapHint: "Selecciona un agente o tarea para inspeccionar su actividad.",
  waiting: "Listos / pausados", running: "En actividad", attention: "Requieren atención", completed: "Completados", task: "Tarea",
  limitHint: "Se muestran los resultados más conectados. Refina la carpeta, búsqueda o conexiones para explorar más.",
};
export const graphCopy = (locale: string) => locale.startsWith("pt") ? pt : locale.startsWith("es") ? es : en;
