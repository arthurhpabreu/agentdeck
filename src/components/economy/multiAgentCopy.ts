const pt = {
  badge: "Multimodelo", badgeHint: "Economia só nos agentes auxiliares. Seu modelo principal, esforço, Fast e Ultra são preservados.",
  title: "Distribuição de modelos", toggle: "Distribuir tarefas entre modelos", future: "Aplica-se às próximas execuções. Não altera agentes já em andamento.",
  description: "Seu modelo principal conduz o trabalho. A economia distribui consultas e análises complexas entre agentes auxiliares disponíveis no CLI selecionado e funciona sem RTK.",
  preserved: "O modelo principal, o esforço, Fast e Ultra escolhidos no chat são preservados. A economia altera apenas os modelos dos agentes auxiliares.", nativeHint: "O assessor nativo depende da disponibilidade do provedor; suas chamadas consomem tokens adicionais.",
  coordinator: "Principal (sua seleção)", explorer: "Exploração e consultas", advisor: "Análises complexas", nativeAdvisor: "Assessoria nativa", subagentAdvisor: "Assessoria por agente", defaultEffort: "esforço padrão do chat", defaultModel: "Padrão do chat",
  estimate: "Economia por distribuição de modelos auxiliares: ainda sem estimativa; depende das tarefas e dos tokens usados por modelo.",
  checking: "Consultando os modelos disponíveis…", saving: "Salvando…", refresh: "Reconsultar modelos dos agentes", error: "Não foi possível consultar os modelos. Tente atualizar.", saveError: "Não foi possível salvar esta opção. A configuração anterior foi mantida.",
  unsupported_provider: "Esta distribuição está disponível para Codex e Claude Code.", models_unavailable: "Os modelos necessários não estão disponíveis neste CLI. Atualize a consulta ou desative esta opção antes de executar.", cli_update_required: "Atualize o CLI selecionado ou desative esta opção antes de executar.",
  desktop: "Disponível no aplicativo desktop.", none: "sem raciocínio", minimal: "esforço mínimo", low: "esforço baixo", medium: "esforço médio", high: "esforço alto", xhigh: "esforço muito alto", max: "esforço máximo",
};
type Copy = { [Key in keyof typeof pt]: string };
const en: Copy = {
  badge: "Multi-model", badgeHint: "Economy applies only to auxiliary agents. Your main model, effort, Fast and Ultra are preserved.",
  title: "Model distribution", toggle: "Distribute tasks across models", future: "Applies to future runs. Agents already running keep their settings.",
  description: "Your main model leads the work. Economy distributes queries and complex analysis across auxiliary agents available in the selected CLI and works without RTK.",
  preserved: "The main model, effort, Fast and Ultra selected in chat are preserved. Economy changes only the models used by auxiliary agents.", nativeHint: "The native advisor depends on provider availability; its calls consume additional tokens.",
  coordinator: "Main model (your selection)", explorer: "Exploration and queries", advisor: "Complex analysis", nativeAdvisor: "Native advisor", subagentAdvisor: "Agent advisor", defaultEffort: "chat default effort", defaultModel: "Chat default",
  estimate: "Savings from auxiliary model distribution: no estimate yet; depends on the tasks and tokens used by each model.",
  checking: "Checking available models…", saving: "Saving…", refresh: "Refresh agent models", error: "Could not check available models. Try refreshing.", saveError: "Could not save this option. The previous setting was kept.",
  unsupported_provider: "This distribution is available for Codex and Claude Code.", models_unavailable: "The required models are unavailable in this CLI. Refresh or turn this option off before running.", cli_update_required: "Update the selected CLI or turn this option off before running.",
  desktop: "Available in the desktop app.", none: "no reasoning", minimal: "minimal effort", low: "low effort", medium: "medium effort", high: "high effort", xhigh: "extra high effort", max: "maximum effort",
};
const es: Copy = {
  badge: "Multimodelo", badgeHint: "El ahorro se aplica solo a los agentes auxiliares. Se conservan tu modelo principal, esfuerzo, Fast y Ultra.",
  title: "Distribución de modelos", toggle: "Distribuir tareas entre modelos", future: "Se aplica a próximas ejecuciones. Los agentes en curso mantienen su configuración.",
  description: "Tu modelo principal dirige el trabajo. El ahorro distribuye consultas y análisis complejos entre agentes auxiliares disponibles en el CLI seleccionado y funciona sin RTK.",
  preserved: "Se conservan el modelo principal, el esfuerzo, Fast y Ultra elegidos en el chat. El ahorro cambia solo los modelos de los agentes auxiliares.", nativeHint: "El asesor nativo depende de la disponibilidad del proveedor; sus llamadas consumen tokens adicionales.",
  coordinator: "Principal (tu selección)", explorer: "Exploración y consultas", advisor: "Análisis complejos", nativeAdvisor: "Asesoría nativa", subagentAdvisor: "Asesoría por agente", defaultEffort: "esfuerzo predeterminado del chat", defaultModel: "Predeterminado del chat",
  estimate: "Ahorro por distribución de modelos auxiliares: aún sin estimación; depende de las tareas y los tokens usados por cada modelo.",
  checking: "Consultando los modelos disponibles…", saving: "Guardando…", refresh: "Actualizar modelos de los agentes", error: "No se pudieron consultar los modelos. Intenta actualizar.", saveError: "No se pudo guardar esta opción. Se mantuvo la configuración anterior.",
  unsupported_provider: "Esta distribución está disponible para Codex y Claude Code.", models_unavailable: "Los modelos necesarios no están disponibles en este CLI. Actualiza la consulta o desactiva esta opción antes de ejecutar.", cli_update_required: "Actualiza el CLI seleccionado o desactiva esta opción antes de ejecutar.",
  desktop: "Disponible en la aplicación de escritorio.", none: "sin razonamiento", minimal: "esfuerzo mínimo", low: "esfuerzo bajo", medium: "esfuerzo medio", high: "esfuerzo alto", xhigh: "esfuerzo muy alto", max: "esfuerzo máximo",
};
export function multiAgentCopy(locale: string): Copy { return locale.startsWith("pt") ? pt : locale.startsWith("es") ? es : en; }
