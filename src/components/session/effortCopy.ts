const pt = {
  none: "Sem raciocínio", minimal: "Mínimo",
  title: "Esforço e velocidade", effort: "Esforço", low: "Baixo", medium: "Médio", high: "Alto", xhigh: "Extra alto", max: "Máximo",
  lowHint: "Respostas rápidas para tarefas simples. Menor uso de tokens.", mediumHint: "Equilíbrio entre profundidade, tempo e consumo.", highHint: "Mais análise para tarefas complexas. Consome mais tokens.",
  ultraClaude: "Ultracode", ultraCodex: "Ultra", ultraHintClaude: "Orquestra fluxos de trabalho mantendo o esforço escolhido. Requer Claude Code 2.1.284+ e modelo compatível.",
  ultraHintCodex: "Usa esforço Ultra com delegação automática. Ao desligar, volta ao esforço escolhido.",
  fast: "Fast", fastHint: "Acelera a geração com consumo maior. Depende do modelo, plano e disponibilidade da conta.",
  unsupported: "Selecione um modelo compatível para habilitar.", unknown: "Escolha um modelo do catálogo para ver os níveis, Ultra e Fast disponíveis.",
  noEffort: "Este modelo não oferece controle de esforço.", saved: "Salvo para esta conversa. Aplica-se à próxima execução.", close: "Fechar opções de esforço",
  nativeHint: "No terminal aberto, encerre o processo para alterar as opções e depois clique em Reiniciar.",
  busyNative: "O terminal nativo está aberto. Encerre o processo para enviar uma mensagem aqui.", stopNative: "Encerrar terminal e conversar", stopping: "Encerrando terminal…",
};
const en: typeof pt = {
  none: "None", minimal: "Minimal",
  title: "Effort and speed", effort: "Effort", low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max",
  lowHint: "Quick responses for simple tasks. Lower token usage.", mediumHint: "Balances depth, time and usage.", highHint: "Deeper analysis for complex tasks. Uses more tokens.",
  ultraClaude: "Ultracode", ultraCodex: "Ultra", ultraHintClaude: "Orchestrates workflows at the chosen effort. Requires Claude Code 2.1.284+ and a compatible model.", ultraHintCodex: "Uses Ultra effort with automatic delegation. Turning it off restores your chosen effort.",
  fast: "Fast", fastHint: "Faster generation with higher usage. Subject to model, plan and account availability.", unsupported: "Select a compatible model to enable.", unknown: "Choose a catalogue model to see supported levels, Ultra and Fast.",
  noEffort: "This model does not offer effort control.", saved: "Saved for this conversation. Applies to the next run.", close: "Close effort options", nativeHint: "Stop the open terminal process to change options, then click Restart.",
  busyNative: "The native terminal is open. Stop its process to send a message here.", stopNative: "Stop terminal and chat", stopping: "Stopping terminal…",
};
const es: typeof pt = {
  none: "Sin razonamiento", minimal: "Mínimo",
  title: "Esfuerzo y velocidad", effort: "Esfuerzo", low: "Bajo", medium: "Medio", high: "Alto", xhigh: "Extra alto", max: "Máximo",
  lowHint: "Respuestas rápidas para tareas simples. Menor uso de tokens.", mediumHint: "Equilibra profundidad, tiempo y consumo.", highHint: "Más análisis para tareas complejas. Consume más tokens.",
  ultraClaude: "Ultracode", ultraCodex: "Ultra", ultraHintClaude: "Orquesta flujos de trabajo con el esfuerzo elegido. Requiere Claude Code 2.1.284+ y un modelo compatible.", ultraHintCodex: "Usa esfuerzo Ultra con delegación automática. Al desactivarlo, restaura el esfuerzo elegido.",
  fast: "Fast", fastHint: "Generación más rápida con mayor consumo. Depende del modelo, plan y disponibilidad de la cuenta.", unsupported: "Selecciona un modelo compatible para habilitar.", unknown: "Elige un modelo del catálogo para ver niveles, Ultra y Fast disponibles.",
  noEffort: "Este modelo no ofrece control de esfuerzo.", saved: "Guardado para esta conversación. Se aplica a la próxima ejecución.", close: "Cerrar opciones de esfuerzo", nativeHint: "Detén el proceso de la terminal para cambiar opciones y pulsa Reiniciar.",
  busyNative: "La terminal nativa está abierta. Detén su proceso para enviar un mensaje aquí.", stopNative: "Detener terminal y conversar", stopping: "Deteniendo terminal…",
};
export const effortCopy = (locale: string) => locale.startsWith("pt") ? pt : locale.startsWith("es") ? es : en;
