# Continuidade, subagentes e economia — 20/10/2026

Auditoria e correções locais da continuidade de conversas, entrada adicional, observabilidade e coordenação entre chats. Esta entrega contém código e verificações locais; não publica nem instala uma nova versão do aplicativo.

## Conversas longas e entrada adicional

- A escrita síncrona de prompts no stdin segurava o mesmo mutex necessário ao processamento de stdout. Um prompt grande, combinado com saída suficiente para encher os buffers, podia bloquear os dois lados. [chat_live.rs](../../src-tauri/src/chat_live.rs) agora usa uma fila limitada e um escritor dedicado; falhas de escrita são notificadas independentemente da leitura de eventos.
- O transporte aceitava somente **256 KiB** por texto. O limite passa a **2 MiB de UTF-8** tanto no envio inicial quanto no additional input, com mensagem que informa os bytes reais. [chatInput.ts](../../src/services/chatInput.ts) aplica o mesmo limite na interface. O limite de transporte não garante que o contexto caiba no modelo do provedor.
- A estimativa conservadora em bytes ÷ 3 também bloqueava pedidos quando ultrapassava a janela informada, embora não seja um tokenizer exato. Ela agora orienta o aviso e a compactação; a aceitação efetiva do contexto cabe ao provedor. O limite explícito em bytes continua protegendo o transporte.
- Colar milhares de linhas Unicode pelo caminho de edição nativo do Chromium ultrapassou 30 segundos, inclusive em uma página mínima sem React. [CommandTextarea.tsx](../../src/components/session/CommandTextarea.tsx) trata colagens grandes por substituição controlada, preservando seleção, texto integral e cursor. O campo usa altura limitada para rascunhos grandes. O teste integrado com 12 mil linhas passou em cerca de cinco segundos, incluindo abertura, envio e recuperação de falha; isso não é uma medição isolada de latência de colagem.
- [ChatUserText.tsx](../../src/components/session/ChatUserText.tsx) recolhe mensagens de usuário extensas na apresentação, com opção de ler o texto completo. O conteúdo enviado, copiado, salvo e exportado permanece integral.
- A leitura de eventos JSONL comporta o crescimento causado por caracteres escapados. Linhas grandes demais e erros de leitura geram falha explícita de recuperação, em vez de descartar silenciosamente confirmações ou conclusão.
- [chat.rs](../../src-tauri/src/chat.rs) exige confirmação nativa de conclusão bem-sucedida: encerrar o processo com código zero, isoladamente, não comprova conclusão. Cancelamento e falhas finalizam também as entradas adicionais pendentes. Não há reenvio automático de prompts, que poderia duplicar ações.
- Confirmações RPC tardias não podem reabrir um turno já encerrado. A retomada nativa preserva a sessão; não é necessário reenviar todo o histórico pelo aplicativo.
- Rascunhos novos sobrevivem a cancelamento durante a inicialização, falhas de entrega e transição de complemento para um novo turno. Uma conclusão recuperada sem o evento de confirmação marca a mensagem pendente e mantém o texto disponível, sem assumir entrega.
- A limpeza após conclusão confirmada encerra o transporte sem matar processos descendentes intencionais, tanto em Claude quanto em Codex. Cancelamento explícito e erro mantêm o encerramento da árvore de processos.

A simulação determinística de pipe bloqueado demonstra o deadlock corrigido. Não foi reproduzido o incidente específico da captura de tela, e este diagnóstico não atribui falhas externas do provedor ao aplicativo.

## Subagentes

[agent_observability.rs](../../src-tauri/src/agent_observability.rs) agora combina os eventos e registros nativos disponíveis para cada CLI:

| Provedor | Evidência usada | Limites |
| --- | --- | --- |
| Claude | Hierarquia e eventos nativos já suportados | Mantém o comportamento existente. |
| Codex | Metadados `session_meta`, eventos de spawn/wait/interação/resume/close e resultados de ferramentas de colaboração | A hierarquia nativa é a fonte de vínculo; não associa agentes apenas pela pasta. Confirmação de spawn não significa que o filho terminou. |
| Gemini | JSONL de sessões, relação nativa com diretório do pai e `toolCalls[].agentId`; JSON legado limitado | Não coleta `thoughts`. Só configura `--session-id` quando o `--help` instalado confirma suporte; preserva IDs de retomada. |

Os leitores específicos ficam em [agent_observability_codex.rs](../../src-tauri/src/agent_observability_codex.rs) e [agent_observability_gemini.rs](../../src-tauri/src/agent_observability_gemini.rs). A interface deixou de declarar Gemini genericamente incompatível. Os leitores são limitados e somente de leitura; ausência de metadados nativos continua aparecendo como vínculo indisponível. Execução interna de agentes remotos/A2A só pode ser mostrada quando o provedor persiste evidência correspondente.

## RTK e distribuição de modelos

Não foi encontrado, no código atual, um comando que desligue uma opção ao ligar a outra. Elas têm arquivos de configuração, eventos e stores separados. A interface, porém, mostrava o estado da economia RTK como se representasse todas as opções; uma consulta antiga também podia sobrescrever visualmente uma alteração recebida de outra janela.

Correções em [TokenEconomyControl.tsx](../../src/components/economy/TokenEconomyControl.tsx) e [tokenEconomyStore.ts](../../src/store/tokenEconomyStore.ts): estado RTK explícito, badge multimodelo independente, explicação de coexistência e descarte de consultas anteriores a mudanças sincronizadas.

- **RTK** compacta saídas de comandos compatíveis. As medições em bytes ÷ 4 são estimativas de saída, não consumo total, cobrança ou saldo de assinatura.
- **Distribuição de modelos** escolhe modelos auxiliares disponíveis para consultas e revisão. Pode reduzir custo por tarefa, mas criar agentes e enviar contexto também consome tokens; não há percentual de economia de assinatura demonstrado. O modelo principal, esforço, Fast, Ultra e permissões permanecem preservados.
- As duas opções podem atuar juntas. Os overlays Claude de [token_economy.rs](../../src-tauri/src/token_economy.rs) e [memory_capture.rs](../../src-tauri/src/memory_capture.rs) agora compõem o último `--settings` efetivo, preservando hooks e opções do usuário e respeitando o separador `--`.
- Configurações relativas são resolvidas no diretório real da sessão/worktree; os argumentos MCP são inseridos antes de `--`, preservando textos literais e permissões existentes. Um teste integrado verifica essa composição.
- [multi_agent_terminal.rs](../../src-tauri/src/multi_agent_terminal.rs) preserva instruções fornecidas por arquivo e evita repetir os mesmos sufixos RTK, distribuição e memória em tentativas compostas. A orientação adicional de sessão também é idempotente.
- [multi_agent.rs](../../src-tauri/src/multi_agent.rs) orienta delegações com contexto novo quando suportado, escopo restrito, reutilização de evidências válidas, até oito achados em 400 palavras e uma assessoria por decisão ainda não resolvida. Essas são orientações ao agente, não um orçamento rígido de inferência.

A distribuição automática permanece disponível somente nos catálogos verificados de Codex e Claude; isso é independente do rastreamento de subagentes Gemini. Saídas comprimidas que perderem detalhes necessários precisam ser recuperadas antes de concluir uma verificação.

## Chats do mesmo projeto

O painel **Chats do projeto** mostra outros chats, pasta/worktree, estado, atividade e resumo de trabalho. É possível abrir um chat, registrar um resumo e enviar notas curtas a sua caixa de entrada. A coordenação pode ser desativada por chat e funciona independentemente da memória compartilhada.

[project_coordination.rs](../../src-tauri/src/project_coordination.rs) mantém presença e caixas de entrada locais por projeto canônico. As ferramentas MCP `project_peers`, `project_status`, `project_send` e `project_inbox` permitem aos agentes consultar e trocar notas quando necessário. São respostas limitadas, com paginação por cursor; o histórico completo de outras conversas não é injetado no contexto.

As respostas MCP têm orçamento de 16 KiB. Presença usa páginas de até dez chats; notas usam cursor sem pular mensagens que excedam o orçamento da página. Há limite de vinte envios por minuto por remetente, retenção de sete dias e até cinco mil notas recentes por projeto. Acesso SQLite e resolução de pastas dos comandos da interface executam fora da thread da interface.

As notas são dados de coordenação não confiáveis e não transferem autorização de publicação, identidade, credenciais ou permissões. Enviar uma nota não interrompe nem inicia automaticamente uma tarefa no destinatário. A presença pode ficar desatualizada; o painel identifica esse estado. Sessões, autenticação e isolamento de cada chat continuam necessários.

## Verificações

| Verificação | Resultado confirmado |
| --- | --- |
| `economy.spec.ts`, Edge, servidor isolado na porta 1424 | **11 passaram**; inclui quatro combinações RTK/multimodelo, sincronização entre janelas, seleção do modelo e uso/cache. |
| Rust `cargo test economy -- --test-threads=1` | **7 passaram, 1 ignorado**; o ignorado exige instalação local RTK para integração. |
| Rust `cargo test multi_agent -- --test-threads=1` | **17 passaram**; inclui composição modelo + RTK + memória e deduplicação de sufixos compostos. |
| `check:i18n` | **486 chaves EN/PT/ES verificadas**, incluindo placeholders e referências estáticas. |
| Inspeção visual do painel de economia | Estado separado e explicação legíveis, sem sobreposição no viewport verificado. |
| Rust completo `cargo test --lib -- --test-threads=1` | **302 passaram, 0 falhas e 7 ignorados previstos pela suíte**, incluindo pipes, confirmações tardias, descendente Windows, observabilidade e caixas de entrada. |
| Chromium/Edge: continuidade, compactação, entrada adicional, observabilidade, arquivo, anexos e sessões simultâneas | **55 passaram** em execução conjunta. |
| Painel de coordenação com paginação, envio e desativação | **Passou novamente após a integração da paginação**; inspeção visual da apresentação ativada e desativada. |
| Build de produção, tradução, formatação Rust e higiene do repositório | Verificados na consolidação local. O build mantém avisos de tamanho de bundles e de imports mistos já existentes. |

As verificações não executaram turnos pagos nem conversas com provedores autenticados. Não alteraram autenticação global, publicaram o aplicativo ou comprovaram redução do consumo total de tokens em tarefas reais. Os testes determinísticos validam os caminhos de transporte, estado e composição; a validação final com os CLIs autenticados continua distinta desses resultados.

As semânticas de steering e conclusão do Codex foram conferidas na [documentação oficial do App Server](https://learn.chatgpt.com/docs/app-server). Os formatos de telemetria foram conferidos nas fontes oficiais do [protocolo Codex](https://github.com/openai/codex/blob/main/codex-rs/protocol/src/protocol.rs), do [gravador Gemini](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/services/chatRecordingService.ts) e na [documentação de subagentes Gemini](https://geminicli.com/docs/core/subagents/).
