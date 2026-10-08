const messages = {
  title: ["Worktrees preservados", "Preserved worktrees", "Worktrees conservados"],
  hint: ["Revise pastas de sessões anteriores. A limpeza remove apenas a pasta sem alterações e mantém a branch. Arquivos locais, pastas bloqueadas e sessões em uso são preservados.", "Review folders from previous sessions. Cleanup removes only an unchanged folder and keeps its branch. Local files, locked folders and sessions in use are preserved.", "Revisa carpetas de sesiones anteriores. La limpieza elimina solo la carpeta sin cambios y conserva la rama. Se conservan los archivos locales, las carpetas bloqueadas y las sesiones en uso."],
  repository: ["Repositório", "Repository", "Repositorio"],
  choose: ["Escolher repositório", "Choose repository", "Elegir repositorio"],
  refresh: ["Atualizar", "Refresh", "Actualizar"],
  close: ["Fechar", "Close", "Cerrar"],
  loading: ["Verificando worktrees…", "Checking worktrees…", "Verificando worktrees…"],
  empty: ["Nenhum worktree de sessão encontrado neste repositório.", "No session worktrees found in this repository.", "No se encontraron worktrees de sesión en este repositorio."],
  noRepository: ["Escolha um repositório para localizar as pastas preservadas.", "Choose a repository to find preserved folders.", "Elige un repositorio para localizar las carpetas conservadas."],
  clean: ["Pasta limpa; disponível para limpeza", "Clean folder; available for cleanup", "Carpeta limpia; disponible para limpieza"],
  dirty: ["Arquivos locais ou alterações pendentes. Abra a pasta e salve ou mova seu trabalho antes de limpar.", "Local files or pending changes. Open the folder and save or move your work before cleanup.", "Archivos locales o cambios pendientes. Abre la carpeta y guarda o mueve tu trabajo antes de limpiar."],
  locked: ["Worktree bloqueado pelo Git", "Worktree locked by Git", "Worktree bloqueado por Git"],
  detached: ["Sem branch associada. Crie uma branch para preservar os commits antes de limpar.", "No attached branch. Create a branch to preserve commits before cleanup.", "Sin rama asociada. Crea una rama para conservar los commits antes de limpiar."],
  in_use: ["Worktree em uso por uma sessão", "Worktree in use by a session", "Worktree en uso por una sesión"],
  unavailable: ["Pasta indisponível; verifique sua localização", "Folder unavailable; check its location", "Carpeta no disponible; comprueba su ubicación"],
  open: ["Abrir pasta", "Open folder", "Abrir carpeta"],
  copy: ["Copiar caminho", "Copy path", "Copiar ruta"],
  copied: ["Caminho copiado", "Path copied", "Ruta copiada"],
  cleanAction: ["Limpar worktree", "Clean worktree", "Limpiar worktree"],
  confirm: ["Confirmar limpeza", "Confirm cleanup", "Confirmar limpieza"],
  confirmHint: ["Remover esta pasta? O estado será verificado novamente e a branch será preservada.", "Remove this folder? Its state will be checked again and the branch will be preserved.", "¿Eliminar esta carpeta? Se verificará otra vez su estado y se conservará la rama."],
  cancel: ["Cancelar", "Cancel", "Cancelar"],
  removed: ["Pasta removida. A branch foi preservada.", "Folder removed. Its branch was preserved.", "Carpeta eliminada. Se conservó la rama."],
  notice: ["Há pastas de sessões preservadas. Revise os worktrees para recuperar seus arquivos.", "Session folders were preserved. Review worktrees to recover your files.", "Se conservaron carpetas de sesiones. Revisa los worktrees para recuperar tus archivos."],
} as const;
export function worktreeCopy(locale: string) {
  const index = locale.startsWith("pt") ? 0 : locale.startsWith("es") ? 2 : 1;
  return Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, values[index]])) as Record<keyof typeof messages, string>;
}
