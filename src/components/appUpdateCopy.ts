const pt = {
  title: "Atualizações do Agent Deck", description: "Verificamos novas versões ao abrir o aplicativo. O instalador substitui a versão atual e mantém suas sessões e memórias.",
  check: "Verificar nova versão", checking: "Verificando…", installed: "Instalada", latest: "Disponível", current: "Agent Deck atualizado", available: "Nova versão do Agent Deck",
  download: "Baixar atualização", downloading: "Baixando atualização…", ready: "Download verificado e pronto para instalar.", install: "Instalar atualização", installing: "Abrindo instalador…",
  opened: "Instalador aberto. Feche o Agent Deck e conclua a instalação; depois abra o aplicativo novamente.", busy: "Encerre os agentes e terminais antes de instalar. Você pode baixar a atualização enquanto trabalha.",
  network: "Não foi possível consultar a release oficial. Verifique sua conexão e tente novamente.", invalid: "O instalador não passou na verificação. Baixe novamente ou confira a release oficial.",
  failed: "Não foi possível concluir a atualização. Tente novamente.", unsupported: "As atualizações pelo aplicativo estão disponíveis para Windows x64 e macOS (Intel e Apple Silicon).", pending: "Verificação pendente", source: "Releases oficiais do Agent Deck no GitHub", link: "Abrir releases oficiais",
};
const en: typeof pt = {
  title: "Agent Deck updates", description: "New versions are checked when the app opens. The installer replaces the current version and keeps your sessions and memories.",
  check: "Check for a new version", checking: "Checking…", installed: "Installed", latest: "Available", current: "Agent Deck is up to date", available: "New Agent Deck version",
  download: "Download update", downloading: "Downloading update…", ready: "Download verified and ready to install.", install: "Install update", installing: "Opening installer…",
  opened: "Installer opened. Close Agent Deck and complete setup, then reopen the app.", busy: "Stop agents and terminals before installing. You can download the update while working.",
  network: "Could not reach the official release. Check your connection and retry.", invalid: "The installer did not pass verification. Download it again or check the official release.",
  failed: "Could not complete the update. Try again.", unsupported: "In-app updates are available for Windows x64 and macOS (Intel and Apple Silicon).", pending: "Check pending", source: "Official Agent Deck releases on GitHub", link: "Open official releases",
};
const es: typeof pt = {
  title: "Actualizaciones de Agent Deck", description: "Buscamos nuevas versiones al abrir la aplicación. El instalador sustituye la versión actual y conserva tus sesiones y memorias.",
  check: "Buscar nueva versión", checking: "Verificando…", installed: "Instalada", latest: "Disponible", current: "Agent Deck actualizado", available: "Nueva versión de Agent Deck",
  download: "Descargar actualización", downloading: "Descargando actualización…", ready: "Descarga verificada y lista para instalar.", install: "Instalar actualización", installing: "Abriendo instalador…",
  opened: "Instalador abierto. Cierra Agent Deck y completa la instalación; después vuelve a abrir la aplicación.", busy: "Detén los agentes y terminales antes de instalar. Puedes descargar la actualización mientras trabajas.",
  network: "No se pudo consultar la versión oficial. Revisa tu conexión e inténtalo de nuevo.", invalid: "El instalador no pasó la verificación. Descárgalo de nuevo o revisa la versión oficial.",
  failed: "No se pudo completar la actualización. Inténtalo de nuevo.", unsupported: "Las actualizaciones desde la aplicación están disponibles para Windows x64 y macOS (Intel y Apple Silicon).", pending: "Verificación pendiente", source: "Versiones oficiales de Agent Deck en GitHub", link: "Abrir versiones oficiales",
};
const macPt = {
  description: "Verificamos novas versões ao abrir o aplicativo. Baixe a atualização verificada e substitua o Agentdeck na pasta Aplicativos. Suas sessões e memórias são mantidas.",
  ready: "Download verificado. Abra a imagem de disco para atualizar o aplicativo.", install: "Abrir imagem de disco", installing: "Abrindo imagem de disco…",
  opened: "Imagem de disco aberta. Feche o Agentdeck, arraste o aplicativo para Aplicativos e confirme a substituição. Depois abra o Agentdeck novamente.",
  invalid: "A atualização não passou na verificação. Baixe novamente ou confira a release oficial.",
};
const macEn: typeof macPt = {
  description: "New versions are checked when the app opens. Download the verified update and replace Agentdeck in Applications. Your sessions and memories are kept.",
  ready: "Download verified. Open the disk image to update the app.", install: "Open disk image", installing: "Opening disk image…",
  opened: "Disk image opened. Close Agentdeck, drag the app to Applications and confirm replacement. Then reopen Agentdeck.",
  invalid: "The update did not pass verification. Download it again or check the official release.",
};
const macEs: typeof macPt = {
  description: "Buscamos nuevas versiones al abrir la aplicación. Descarga la actualización verificada y sustituye Agentdeck en Aplicaciones. Tus sesiones y memorias se conservan.",
  ready: "Descarga verificada. Abre la imagen de disco para actualizar la aplicación.", install: "Abrir imagen de disco", installing: "Abriendo imagen de disco…",
  opened: "Imagen de disco abierta. Cierra Agentdeck, arrastra la aplicación a Aplicaciones y confirma la sustitución. Después vuelve a abrir Agentdeck.",
  invalid: "La actualización no pasó la verificación. Descárgala de nuevo o revisa la versión oficial.",
};
export function appUpdateCopy(locale: string, os: string = "windows"): typeof pt {
  const base = locale.startsWith("en") ? en : locale.startsWith("es") ? es : pt;
  return os === "macos" ? { ...base, ...(locale.startsWith("en") ? macEn : locale.startsWith("es") ? macEs : macPt) } : base;
}
export function appUpdateError(error: string, c: typeof pt) {
  return error.includes("update_busy") ? c.busy : error.includes("network") ? c.network : /checksum|installer_invalid|release_invalid|release_assets_missing/.test(error) ? c.invalid : c.failed;
}
