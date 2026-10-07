const strings = {
  fullAccess: ["Acesso total à máquina", "Full machine access", "Acceso total al equipo"],
  fullHint: ["Executa ferramentas com acesso completo em modo Código. Desative para usar as permissões da CLI.", "Runs tools with full access in Code mode. Disable to use CLI permissions.", "Ejecuta herramientas con acceso completo en modo Código. Desactiva para usar los permisos del CLI."],
  planAccess: ["O modo Planejamento permanece somente leitura.", "Plan mode remains read only.", "El modo Planificación sigue siendo de solo lectura."],
  supplement: ["Enviar complemento", "Send additional input", "Enviar complemento"],
  liveHint: ["Você pode enviar complementos enquanto a IA trabalha.", "You can send additional input while the agent works.", "Puedes enviar complementos mientras trabaja la IA."],
  sending: ["Enviando complemento…", "Sending additional input…", "Enviando complemento…"],
  accepted: ["Complemento entregue", "Additional input delivered", "Complemento entregado"],
  queued: ["Complemento encadeado", "Additional input queued", "Complemento encadenado"],
  failed: ["Complemento não entregue — reenviar", "Additional input not delivered — retry", "Complemento no entregado — reenviar"],
  cachePercent: ["Entrada reutilizada do cache", "Input reused from cache", "Entrada reutilizada de caché"],
  rtkLabel: ["RTK", "RTK", "RTK"],
  cacheLabel: ["cache", "cache", "caché"],
  cacheHint: ["Percentual da entrada informado pelo provedor. Não equivale à economia do RTK nem a um desconto medido na conta.", "Provider-reported percentage of input. This is separate from RTK savings and measured account discounts.", "Porcentaje de entrada informado por el proveedor. Es distinto del ahorro RTK y de descuentos medidos en la cuenta."],
  textOnly: ["Conversas sem comandos não geram medições RTK. O uso e o cache da IA aparecem abaixo quando o provedor os informa.", "Conversations without commands do not produce RTK measurements. AI usage and cache appear below when reported.", "Las conversaciones sin comandos no generan mediciones RTK. El uso y la caché aparecen abajo cuando el proveedor los informa."],
} satisfies Record<string, readonly [string,string,string]>;
export function workflowCopy(locale:string):{[K in keyof typeof strings]:string} {
  const index = locale.startsWith("pt") ? 0 : locale.startsWith("es") ? 2 : 1;
  return Object.fromEntries(Object.entries(strings).map(([key,value])=>[key,value[index]])) as {[K in keyof typeof strings]:string};
}
