export function improvementsCopy(locale: string) {
  const index = locale.startsWith("pt") ? 0 : locale.startsWith("es") ? 2 : 1;
  const rows = {
    attention: ["Precisa de você", "Needs you", "Te necesita"], empty: ["Nenhuma ação pendente.", "No pending actions.", "No hay acciones pendientes."],
    question: ["Pergunta", "Question", "Pregunta"], approval: ["Aprovação", "Approval", "Aprobación"], error: ["Erro confirmado", "Confirmed error", "Error confirmado"], completed: ["Conclusão não lida", "Unread completion", "Finalización sin leer"],
    read: ["Marcar como lido", "Mark read", "Marcar como leído"], close: ["Fechar", "Close", "Cerrar"],
    comment: ["Comentar linhas", "Comment on lines", "Comentar líneas"], commentHint: ["Clique numa linha; Shift+clique seleciona uma faixa.", "Click a line; Shift+click selects a range.", "Haz clic en una línea; Mayús+clic selecciona un rango."],
    review: ["Revisão para o agente", "Review for agent", "Revisión para el agente"], add: ["Adicionar comentário", "Add comment", "Añadir comentario"], remove: ["Remover", "Remove", "Eliminar"], send: ["Enviar revisão inteira", "Send complete review", "Enviar revisión completa"],
    stale: ["O diff mudou. Revise a referência antes de enviar.", "The diff changed. Review this reference before sending.", "El diff cambió. Revisa esta referencia antes de enviar."], reanchor: ["Confirmar referência atual", "Confirm current reference", "Confirmar referencia actual"],
    agent: ["Agente destinatário", "Recipient agent", "Agente destinatario"], noAgent: ["Abra uma conversa deste projeto.", "Open a conversation in this project.", "Abre una conversación de este proyecto."],
    favorites: ["Favoritos", "Favorites", "Favoritos"], recent: ["Recentes", "Recent", "Recientes"], files: ["Arquivos", "Files", "Archivos"], favorite: ["Favoritar", "Favorite", "Añadir a favoritos"], unfavorite: ["Remover favorito", "Unfavorite", "Quitar de favoritos"],
    selectedContext: ["Adicionar seleção à conversa", "Add selection to conversation", "Añadir selección a la conversación"],
    historyRestored: ["Histórico restaurado", "History restored", "Historial restaurado"], nativeResumed: ["Sessão do provedor retomada", "Provider session resumed", "Sesión del proveedor reanudada"], newContext: ["Novo chat com contexto", "New chat with context", "Nuevo chat con contexto"],
    checkpoints: ["Checkpoints", "Checkpoints", "Puntos de recuperación"], createCheckpoint: ["Salvar checkpoint", "Save checkpoint", "Guardar punto"], restoreCheckpoint: ["Recuperar como nova conversa", "Recover as new conversation", "Recuperar como nueva conversación"],
    correctSources: ["Novo chat com fontes corretas", "New chat with correct sources", "Nuevo chat con fuentes correctas"],
    reviewContext: ["Revise o contexto a transferir", "Review the context to transfer", "Revisa el contexto que deseas transferir"],
    reviewHint: ["Remova conteúdo de fontes fora do escopo atual. O arquivo integral permanece na conversa original e não será anexado a este novo agente.", "Remove content from sources outside the current scope. The complete archive stays with the original conversation and will not be attached to this new agent.", "Elimina contenido de fuentes fuera del alcance actual. El archivo completo permanece en la conversación original y no se adjuntará al nuevo agente."],
    createChat: ["Criar conversa com este contexto", "Create conversation with this context", "Crear conversación con este contexto"], cancel: ["Cancelar", "Cancel", "Cancelar"],
  } as const;
  return Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values[index]])) as { [K in keyof typeof rows]: string };
}
