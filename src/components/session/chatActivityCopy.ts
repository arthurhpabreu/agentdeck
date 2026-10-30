const en = {
  pid: "PID",
  responding: "Writing response…",
  waitingBackground: "Waiting for background tasks",
  backgroundHint: "The main response was received, but background tasks are still active. Wait for them to finish, check the process or stop the response.",
  aliveHint: "The process is still active. Long commands such as builds, tests and installs often run without output. Wait, or stop the response if you did not expect a long step.",
  running: "Running", failed: "Failed", stopped: "Interrupted", blocked: "Permission denied", queued: "Queued", thinking: "Agent thinking…", finishing: "Finishing response…", command: "Command", output: "Output", input: "Input", waitingOutput: "Waiting for command output…", showAll: "Show full output", showTail: "Show latest lines", latestLines: "Latest output", activity: "Current activity", lastUpdate: "Last activity", ago: "ago", silent: "No new activity for", silentHint: "The agent may be waiting for a command or a connection. Check the process or stop the response to continue.", check: "Check process", checking: "Checking process…", alive: "Process is running", checkFailed: "Could not check the process. Try again.", exit: "Exit code", subagent: "Subagent", seconds: "s", starting: "Connecting to agent…", working: "Agent working…", complete: "Complete", details: "Execution details",
  changes: "Changes", content: "Content", result: "Result", created: "New file", deleted: "Deleted", moreLines: "more lines",
};
type Copy = typeof en;
const pt: Copy = {
  pid: "PID",
  responding: "Escrevendo resposta…",
  waitingBackground: "Aguardando tarefas em segundo plano",
  backgroundHint: "A resposta principal foi recebida, mas ainda há tarefas ativas em segundo plano. Aguarde a conclusão, verifique o processo ou pare a resposta.",
  aliveHint: "O processo continua ativo. Comandos longos, como builds, testes e instalações, costumam rodar sem saída. Aguarde ou pare a resposta se não esperava uma etapa longa.",
  running: "Executando", failed: "Falhou", stopped: "Interrompido", blocked: "Permissão negada", queued: "Na fila", thinking: "Agente pensando…", finishing: "Finalizando resposta…", command: "Comando", output: "Saída", input: "Entrada", waitingOutput: "Aguardando saída do comando…", showAll: "Ver saída completa", showTail: "Ver últimas linhas", latestLines: "Saída recente", activity: "Atividade atual", lastUpdate: "Última atividade", ago: "atrás", silent: "Sem nova atividade há", silentHint: "O agente pode estar aguardando um comando ou uma conexão. Verifique o processo ou pare a resposta para continuar.", check: "Verificar processo", checking: "Verificando processo…", alive: "Processo em execução", checkFailed: "Não foi possível verificar o processo. Tente novamente.", exit: "Código de saída", subagent: "Subagente", seconds: "s", starting: "Conectando ao agente…", working: "Agente trabalhando…", complete: "Concluído", details: "Detalhes da execução",
  changes: "Alterações", content: "Conteúdo", result: "Resultado", created: "Arquivo novo", deleted: "Excluído", moreLines: "linhas a mais",
};
const es: Copy = {
  pid: "PID",
  responding: "Escribiendo respuesta…",
  waitingBackground: "Esperando tareas en segundo plano",
  backgroundHint: "Se recibió la respuesta principal, pero aún hay tareas activas en segundo plano. Espera a que terminen, comprueba el proceso o detén la respuesta.",
  aliveHint: "El proceso sigue activo. Los comandos largos, como compilaciones, pruebas e instalaciones, suelen ejecutarse sin salida. Espera o detén la respuesta si no esperabas un paso largo.",
  running: "Ejecutando", failed: "Falló", stopped: "Interrumpido", blocked: "Permiso denegado", queued: "En cola", thinking: "Agente pensando…", finishing: "Finalizando respuesta…", command: "Comando", output: "Salida", input: "Entrada", waitingOutput: "Esperando la salida del comando…", showAll: "Ver salida completa", showTail: "Ver últimas líneas", latestLines: "Salida reciente", activity: "Actividad actual", lastUpdate: "Última actividad", ago: "atrás", silent: "Sin nueva actividad desde hace", silentHint: "El agente puede estar esperando un comando o una conexión. Comprueba el proceso o detén la respuesta para continuar.", check: "Comprobar proceso", checking: "Comprobando proceso…", alive: "Proceso en ejecución", checkFailed: "No se pudo comprobar el proceso. Reintenta.", exit: "Código de salida", subagent: "Subagente", seconds: "s", starting: "Conectando con el agente…", working: "Agente trabajando…", complete: "Completado", details: "Detalles de ejecución",
  changes: "Cambios", content: "Contenido", result: "Resultado", created: "Archivo nuevo", deleted: "Eliminado", moreLines: "líneas más",
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
