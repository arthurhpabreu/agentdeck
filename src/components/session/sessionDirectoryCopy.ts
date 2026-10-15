const copy = {
  label: ["Pasta da nova conversa", "New conversation folder", "Carpeta de la nueva conversación"],
  project: ["Usar pasta do projeto", "Use project folder", "Usar carpeta del proyecto"],
  worktree: ["Criar worktree isolado", "Create isolated worktree", "Crear worktree aislado"],
  projectHint: ["Economiza espaço. As conversas compartilham os arquivos e as alterações do projeto.", "Saves space. Conversations share the project's files and changes.", "Ahorra espacio. Las conversaciones comparten los archivos y los cambios del proyecto."],
  worktreeHint: ["Cria uma cópia dos arquivos em outra pasta e uma branch própria. Dependências e builds podem ocupar espaço extra.", "Creates a copy of the files in another folder with its own branch. Dependencies and builds can use extra space.", "Crea una copia de los archivos en otra carpeta con su propia rama. Las dependencias y compilaciones pueden ocupar espacio adicional."],
  unavailable: ["Não foi possível criar o worktree isolado. Escolha um repositório Git com uma branch ativa ou use a pasta do projeto.", "Could not create an isolated worktree. Choose a Git repository with an active branch or use the project folder.", "No se pudo crear el worktree aislado. Elige un repositorio Git con una rama activa o usa la carpeta del proyecto."],
  failure: ["Não foi possível criar a conversa", "Could not create the conversation", "No se pudo crear la conversación"],
  cancelled: ["Criação cancelada porque o projeto foi removido ou alterado. Qualquer worktree criado foi preservado para revisão.", "Creation cancelled because the project was removed or changed. Any worktree created was preserved for review.", "Creación cancelada porque el proyecto se eliminó o cambió. Cualquier worktree creado se conservó para revisión."],
};

export function sessionDirectoryCopy(locale: string) {
  const index = locale.startsWith("pt") ? 0 : locale.startsWith("es") ? 2 : 1;
  return Object.fromEntries(Object.entries(copy).map(([key, values]) => [key, values[index]])) as Record<keyof typeof copy, string>;
}
