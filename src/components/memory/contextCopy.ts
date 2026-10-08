const messages = {
  sources: ["Fontes do contexto", "Context sources", "Fuentes del contexto"],
  prepared: ["Contexto preparado; envio ainda não confirmado", "Context prepared; delivery not yet confirmed", "Contexto preparado; envío aún no confirmado"],
  delivered: ["Contexto enviado ao agente", "Context sent to the agent", "Contexto enviado al agente"],
  legacy: ["Última recuperação registrada", "Last recorded retrieval", "Última recuperación registrada"],
  hint: ["Estes são os trechos incluídos pelo app. O envio não garante que o modelo os utilizou na resposta.", "These are the excerpts included by the app. Delivery does not guarantee the model used them in its answer.", "Estos son los fragmentos incluidos por la app. El envío no garantiza que el modelo los utilizó en su respuesta."],
  empty: ["Nenhuma fonte incluída nesta recuperação.", "No sources included in this retrieval.", "Ninguna fuente incluida en esta recuperación."],
  unavailableDetails: ["Esta recuperação não registrou detalhes das fontes.", "This retrieval did not record source details.", "Esta recuperación no registró detalles de las fuentes."],
  historical: ["Houve uma falha. As fontes abaixo pertencem à última recuperação registrada.", "An error occurred. The sources below belong to the last recorded retrieval.", "Hubo un error. Las fuentes siguientes pertenecen a la última recuperación registrada."],
  project: ["Projeto", "Project", "Proyecto"], global: ["Global", "Global", "Global"],
  memory: ["Memória", "Memory", "Memoria"], document: ["Documento", "Document", "Documento"],
  warning: ["A recuperação de documentos está incompleta", "Document retrieval is incomplete", "La recuperación de documentos está incompleta"],
  unavailable: ["Pasta indisponível. Verifique o acesso ou selecione sua localização atual em Documentos.", "Folder unavailable. Check access or select its current location in Documents.", "Carpeta no disponible. Comprueba el acceso o selecciona su ubicación actual en Documentos."],
  index_limited: ["Índice parcial: há limites de tamanho ou notas, ou arquivos que não puderam ser lidos.", "Partial index: size or note limits were reached, or some files could not be read.", "Índice parcial: se alcanzaron límites de tamaño o notas, o algunos archivos no pudieron leerse."],
  configuration: ["Não foi possível ler a configuração das fontes.", "Source configuration could not be read.", "No se pudo leer la configuración de las fuentes."],
  close: ["Fechar", "Close", "Cerrar"],
  health: ["Saúde da fonte", "Source health", "Estado de la fuente"],
  check: ["Verificar fonte", "Check source", "Verificar fuente"],
  checking: ["Verificando fonte…", "Checking source…", "Verificando fuente…"],
  ready: ["Fonte disponível", "Source available", "Fuente disponible"],
  limited: ["Índice parcial", "Partial index", "Índice parcial"],
  none: ["Nenhuma pasta selecionada", "No folder selected", "Ninguna carpeta seleccionada"],
  notes: ["notas indexadas", "indexed notes", "notas indexadas"],
  checked: ["Última verificação", "Last checked", "Última verificación"],
  limits: ["Limites do índice", "Index limits", "Límites del índice"],
  perNote: ["por nota", "per note", "por nota"],
  mib: ["MiB", "MiB", "MiB"], kib: ["KiB", "KiB", "KiB"],
} as const;
export function contextCopy(locale: string) {
  const index = locale.startsWith("pt") ? 0 : locale.startsWith("es") ? 2 : 1;
  return Object.fromEntries(Object.entries(messages).map(([key, values]) => [key, values[index]])) as Record<keyof typeof messages, string>;
}
