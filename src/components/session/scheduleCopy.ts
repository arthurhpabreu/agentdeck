const pt = {
  title: "Agendar prompt", schedules: "Agendamentos", prompt: "Prompt agendado", time: "Horário", start: "Data inicial", end: "Data final", days: "Dias da semana",
  save: "Salvar agendamento", cancel: "Cancelar", pause: "Pausar", resume: "Retomar", remove: "Remover", close: "Fechar agendamentos",
  hint: "Executa nesta conversa, com as configurações atuais do agente, enquanto o Agentdeck estiver aberto e o computador acordado. Se o chat estiver ocupado, aguarda até 15 minutos; depois registra o horário como perdido. Horários perdidos não são reenviados.",
  invalid: "Preencha o prompt, o horário e um período válido com pelo menos um dia e uma execução futura.",
  timezone: "Fuso horário", next: "Próxima execução", finished: "Período encerrado", paused: "Pausado", empty: "Nenhum prompt agendado nesta conversa.",
  started: "Último horário enviado", failed: "Falha ao iniciar; confira a conversa antes de tentar novamente.", missed: "Horário perdido (app fechado, computador suspenso ou chat ocupado).", destination: "Destino alterado ou indisponível. Crie um novo agendamento nesta conversa.",
  unsupported: "Agendamentos estão disponíveis no chat do Codex e do Claude Code.", draft: "Salva o texto do prompt, sem anexos. O rascunho do chat é preservado.",
  weekdays: ["Dom", "Seg", "Ter", "Qua", "Qui", "Sex", "Sáb"],
};
type Copy = typeof pt;
const en: Copy = {
  title: "Schedule prompt", schedules: "Schedules", prompt: "Scheduled prompt", time: "Time", start: "Start date", end: "End date", days: "Days of the week",
  save: "Save schedule", cancel: "Cancel", pause: "Pause", resume: "Resume", remove: "Remove", close: "Close schedules",
  hint: "Runs in this conversation with the current agent settings while Agentdeck is open and the computer is awake. A busy chat waits up to 15 minutes, then records the occurrence as missed. Missed prompts are not replayed.",
  invalid: "Enter a prompt, time and valid date range with at least one day and a future occurrence.",
  timezone: "Time zone", next: "Next run", finished: "Schedule ended", paused: "Paused", empty: "No prompts scheduled in this conversation.",
  started: "Last occurrence sent", failed: "Could not start; check the conversation before retrying.", missed: "Missed occurrence (app closed, computer asleep or chat busy).", destination: "Destination changed or unavailable. Create a new schedule in this conversation.",
  unsupported: "Schedules are available in Codex and Claude Code chat.", draft: "Saves the prompt text without attachments. Your chat draft is preserved.",
  weekdays: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"],
};
const es: Copy = {
  title: "Programar prompt", schedules: "Programaciones", prompt: "Prompt programado", time: "Hora", start: "Fecha inicial", end: "Fecha final", days: "Días de la semana",
  save: "Guardar programación", cancel: "Cancelar", pause: "Pausar", resume: "Reanudar", remove: "Eliminar", close: "Cerrar programaciones",
  hint: "Se ejecuta en esta conversación con la configuración actual mientras Agentdeck esté abierto y el equipo activo. Un chat ocupado espera hasta 15 minutos; después registra el horario como perdido. Los prompts perdidos no se reenvían.",
  invalid: "Introduce un prompt, una hora y un período válido con al menos un día y una ejecución futura.",
  timezone: "Zona horaria", next: "Próxima ejecución", finished: "Período terminado", paused: "Pausado", empty: "No hay prompts programados en esta conversación.",
  started: "Último horario enviado", failed: "No se pudo iniciar; revisa la conversación antes de reintentar.", missed: "Horario perdido (app cerrada, equipo suspendido o chat ocupado).", destination: "Destino cambiado o no disponible. Crea una nueva programación.",
  unsupported: "Las programaciones están disponibles en el chat de Codex y Claude Code.", draft: "Guarda el texto del prompt sin adjuntos. El borrador del chat se conserva.",
  weekdays: ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"],
};
export const scheduleCopy = (locale: string): Copy => locale.startsWith("pt") ? pt : locale.startsWith("es") ? es : en;
