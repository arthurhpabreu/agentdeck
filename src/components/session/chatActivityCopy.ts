const en = {
  pid: "PID",
  responding: "Writing response…",
  running: "Running", failed: "Failed", stopped: "Interrupted", blocked: "Needs approval", queued: "Queued", thinking: "Agent thinking…", finishing: "Finishing response…", command: "Command", output: "Output", input: "Input", waitingOutput: "Waiting for command output…", showAll: "Show full output", showTail: "Show latest lines", latestLines: "Latest output", activity: "Current activity", lastUpdate: "Last activity", ago: "ago", silent: "No new activity for", silentHint: "The agent may be waiting for a command or a connection. Check the process or stop the response to continue.", check: "Check process", checking: "Checking process…", alive: "Process is running", checkFailed: "Could not check the process. Try again.", exit: "Exit code", subagent: "Subagent", seconds: "s", starting: "Connecting to agent…", working: "Agent working…", complete: "Complete", details: "Execution details",
};
type Copy = typeof en;
const pt: Copy = {
  pid: "PID",
  responding: "Escrevendo resposta…",
  running: "Executando", failed: "Falhou", stopped: "Interrompido", blocked: "Aguardando aprovação", queued: "Na fila", thinking: "Agente pensando…", finishing: "Finalizando resposta…", command: "Comando", output: "Saída", input: "Entrada", waitingOutput: "Aguardando saída do comando…", showAll: "Ver saída completa", showTail: "Ver últimas linhas", latestLines: "Saída recente", activity: "Atividade atual", lastUpdate: "Última atividade", ago: "atrás", silent: "Sem nova atividade há", silentHint: "O agente pode estar aguardando um comando ou uma conexão. Verifique o processo ou pare a resposta para continuar.", check: "Verificar processo", checking: "Verificando processo…", alive: "Processo em execução", checkFailed: "Não foi possível verificar o processo. Tente novamente.", exit: "Código de saída", subagent: "Subagente", seconds: "s", starting: "Conectando ao agente…", working: "Agente trabalhando…", complete: "Concluído", details: "Detalhes da execução",
};
const es: Copy = {
  pid: "PID",
  responding: "Escribiendo respuesta…",
  running: "Ejecutando", failed: "Falló", stopped: "Interrumpido", blocked: "Esperando aprobación", queued: "En cola", thinking: "Agente pensando…", finishing: "Finalizando respuesta…", command: "Comando", output: "Salida", input: "Entrada", waitingOutput: "Esperando la salida del comando…", showAll: "Ver salida completa", showTail: "Ver últimas líneas", latestLines: "Salida reciente", activity: "Actividad actual", lastUpdate: "Última actividad", ago: "atrás", silent: "Sin nueva actividad desde hace", silentHint: "El agente puede estar esperando un comando o una conexión. Comprueba el proceso o detén la respuesta para continuar.", check: "Comprobar proceso", checking: "Comprobando proceso…", alive: "Proceso en ejecución", checkFailed: "No se pudo comprobar el proceso. Reintenta.", exit: "Código de salida", subagent: "Subagente", seconds: "s", starting: "Conectando con el agente…", working: "Agente trabajando…", complete: "Completado", details: "Detalles de ejecución",
};
export function chatActivityCopy(locale: string): Copy { return locale.startsWith("pt") ? pt : locale.startsWith("es") ? es : en; }
export function toolStatusLabel(status: string | undefined, locale: string): string {
  const c = chatActivityCopy(locale);
  switch (status) {
    case "running": case "in_progress": case "inProgress": case "started": return c.running;
    case "completed": case "success": return c.complete;
    case "failed": case "error": return c.failed;
    case "blocked": return c.blocked;
    case "stopped": case "interrupted": case "cancelled": return c.stopped;
    case "queued": case "pending": return c.queued;
    default: return status || c.running;
  }
}
