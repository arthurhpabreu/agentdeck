export function editorCopy(locale: string) {
  return locale.startsWith("pt") ? {
    discard: (path: string) => `Descartar alterações não salvas em ${path}? Cancelar mantém o arquivo aberto.`,
    retry: "Tentar novamente",
  } : locale.startsWith("es") ? {
    discard: (path: string) => `¿Descartar los cambios sin guardar en ${path}? Cancelar mantiene el archivo abierto.`,
    retry: "Reintentar",
  } : {
    discard: (path: string) => `Discard unsaved changes in ${path}? Cancel keeps the file open.`,
    retry: "Try again",
  };
}
