// Quota copy stays separate from unrelated interface translations.
const pt = {
  title: "Limites das IAs", details: "Uso da assinatura", weekly: "Semanal", monthly: "Mensal", session: "5 horas",
  primary: "Janela principal", secondary: "Janela adicional", spend: "Gastos", "spend-weekly": "Gastos semanais", "spend-daily": "Gastos diários", "monthly-extra": "Extra mensal", "monthly-spend": "Gasto mensal",
  refresh: "Atualizar limites", close: "Fechar detalhes", unavailable: "Sem leitura", error: "Falha na leitura", stale: "Última leitura", ready: "Sincronizado", login: "Login necessário", cooldown: "Aguardando provedor", checking: "Consultando…",
  used: "utilizado", remaining: "disponível", resets: "Renova em", expired: "Aguardando nova leitura", observed: "Leitura de", local: "Dados informados pelo provedor",
  unknown: "Nenhuma medição de limites foi recebida ainda.", guidance: "Exibimos somente as janelas informadas pelo provedor. Limites ausentes não representam saldo zero.",
  claudeGuidance: "A consulta à conta Claude usa o login do cliente oficial neste computador, mesmo sem uma conversa aberta.",
  codexGuidance: "Leitura da atividade recente do Codex neste computador. Use o cliente oficial para obter uma nova medição.",
  staleGuidance: "Esta medição tem mais de 15 minutos ou sua janela terminou. Ela permanece identificada até recebermos uma nova leitura.",
  readError: "Não foi possível ler os limites. Tente atualizar novamente.", window: "Janela", hours: "h", minutes: "min", days: "dias", loading: "Consultando limites…",
  reasonMissingLogin: "Entre no cliente oficial neste computador e atualize os limites novamente.", reasonExpiredLogin: "O login do cliente oficial expirou. Entre novamente no cliente e atualize os limites.", reasonAuthentication: "O provedor não aceitou o login disponível. Confirme sua conta no cliente oficial e tente novamente.",
  reasonRateLimited: "O provedor pediu uma pausa nas consultas. As leituras anteriores permanecem visíveis até a próxima tentativa.", reasonNetwork: "Não foi possível conectar ao provedor. Verifique a conexão e tente atualizar novamente.", reasonUnsupported: "Esta fonte não disponibilizou limites compatíveis para a conta atual.",
  retryAt: "Nova consulta após", retryIn: "Aguarde", retryReady: "Uma nova tentativa já pode ser feita.", savedReading: "Exibindo a última medição recebida; a atualização não foi concluída.",
  source: "Origem", checked: "Última consulta", sourceClaudeAccount: "Conta Claude", sourceClaudeStatusline: "Barra de status do Claude", sourceClaudeStream: "Eventos do Claude", sourceCodex: "Atividade local do Codex", sourceUnknown: "Ainda sem origem disponível", noMonthly: "Uma janela mensal só aparece quando o provedor a informa.",
};
type UsageCopy = { [Key in keyof typeof pt]: string };
const en: UsageCopy = {
  title: "AI limits", details: "Subscription usage", weekly: "Weekly", monthly: "Monthly", session: "5 hours",
  primary: "Primary window", secondary: "Additional window", spend: "Spend", "spend-weekly": "Weekly spend", "spend-daily": "Daily spend", "monthly-extra": "Monthly extra usage", "monthly-spend": "Monthly spend",
  refresh: "Refresh limits", close: "Close details", unavailable: "No reading", error: "Read failed", stale: "Last reading", ready: "Synced", login: "Sign-in required", cooldown: "Waiting for provider", checking: "Checking…",
  used: "used", remaining: "available", resets: "Resets", expired: "Awaiting a new reading", observed: "Reading from", local: "Provider-reported data",
  unknown: "No limit measurement has been received yet.", guidance: "Only windows reported by the provider are shown. Missing limits do not mean a zero balance.",
  claudeGuidance: "The Claude account check uses the official client's sign-in on this computer, even without an open conversation.",
  codexGuidance: "Reads recent Codex activity on this computer. Use the official client to obtain a new measurement.",
  staleGuidance: "This measurement is over 15 minutes old or its window has ended. It stays marked until a new reading arrives.",
  readError: "Could not read limits. Try refreshing again.", window: "Window", hours: "h", minutes: "min", days: "days", loading: "Checking limits…",
  reasonMissingLogin: "Sign in to the official client on this computer, then refresh limits.", reasonExpiredLogin: "The official client's sign-in has expired. Sign in again and refresh limits.", reasonAuthentication: "The provider did not accept the available sign-in. Check your account in the official client and try again.",
  reasonRateLimited: "The provider requested a pause between checks. Previous readings remain visible until the next attempt.", reasonNetwork: "Could not reach the provider. Check your connection and refresh again.", reasonUnsupported: "This source did not provide compatible limits for the current account.",
  retryAt: "Next check after", retryIn: "Wait", retryReady: "A new attempt is available now.", savedReading: "Showing the last measurement received; the refresh did not complete.",
  source: "Source", checked: "Last check", sourceClaudeAccount: "Claude account", sourceClaudeStatusline: "Claude status line", sourceClaudeStream: "Claude events", sourceCodex: "Local Codex activity", sourceUnknown: "No source available yet", noMonthly: "A monthly window appears only when the provider reports one.",
};
const es: UsageCopy = {
  title: "Límites de IA", details: "Uso de la suscripción", weekly: "Semanal", monthly: "Mensual", session: "5 horas",
  primary: "Ventana principal", secondary: "Ventana adicional", spend: "Gastos", "spend-weekly": "Gastos semanales", "spend-daily": "Gastos diarios", "monthly-extra": "Extra mensual", "monthly-spend": "Gasto mensual",
  refresh: "Actualizar límites", close: "Cerrar detalles", unavailable: "Sin lectura", error: "Error de lectura", stale: "Última lectura", ready: "Sincronizado", login: "Inicio de sesión necesario", cooldown: "Esperando al proveedor", checking: "Consultando…",
  used: "utilizado", remaining: "disponible", resets: "Se renueva", expired: "Esperando nueva lectura", observed: "Lectura de", local: "Datos informados por el proveedor",
  unknown: "Todavía no se ha recibido ninguna medición de límites.", guidance: "Solo se muestran las ventanas informadas por el proveedor. Un límite ausente no significa saldo cero.",
  claudeGuidance: "La consulta de la cuenta Claude usa el inicio de sesión del cliente oficial en este equipo, incluso sin una conversación abierta.",
  codexGuidance: "Lee la actividad reciente de Codex en este equipo. Usa el cliente oficial para obtener una nueva medición.",
  staleGuidance: "Esta medición tiene más de 15 minutos o su ventana terminó. Permanece identificada hasta recibir una nueva lectura.",
  readError: "No se pudieron leer los límites. Intenta actualizar de nuevo.", window: "Ventana", hours: "h", minutes: "min", days: "días", loading: "Consultando límites…",
  reasonMissingLogin: "Inicia sesión en el cliente oficial en este equipo y actualiza los límites.", reasonExpiredLogin: "El inicio de sesión del cliente oficial ha caducado. Inicia sesión de nuevo y actualiza los límites.", reasonAuthentication: "El proveedor no aceptó el inicio de sesión disponible. Comprueba tu cuenta en el cliente oficial e inténtalo de nuevo.",
  reasonRateLimited: "El proveedor pidió una pausa entre consultas. Las lecturas anteriores siguen visibles hasta el próximo intento.", reasonNetwork: "No se pudo conectar con el proveedor. Comprueba la conexión y actualiza de nuevo.", reasonUnsupported: "Esta fuente no proporcionó límites compatibles para la cuenta actual.",
  retryAt: "Próxima consulta después de", retryIn: "Espera", retryReady: "Ya se puede realizar un nuevo intento.", savedReading: "Se muestra la última medición recibida; la actualización no se completó.",
  source: "Origen", checked: "Última consulta", sourceClaudeAccount: "Cuenta Claude", sourceClaudeStatusline: "Barra de estado de Claude", sourceClaudeStream: "Eventos de Claude", sourceCodex: "Actividad local de Codex", sourceUnknown: "Todavía no hay una fuente disponible", noMonthly: "Una ventana mensual solo aparece cuando el proveedor la informa.",
};
export const usageMessages = { "pt-BR": pt, "en-US": en, "es-ES": es };
