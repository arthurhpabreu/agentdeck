# Plano de ajustes do Agent Deck e isolamento de conhecimento

Base: Agent Deck 0.7.0. Data: 14 de outubro de 2026. Implementação do marco 0.8: versão 0.8.1, validada e publicada para Windows x64 e macOS universal.

Os recursos deste plano foram implementados. Consulte [política de fontes](../source-policy.md), [inventário de reorganização](../presentation-order.md), [medições de performance](../validation/0.8.0-performance.md) e [notas da versão](../releases/0.8.1.md). O aviso de possível travamento passa a esperar quatro minutos sem atividade, conforme o ajuste solicitado durante a implementação.

Entrega: [release 0.8.1 no GitHub](https://github.com/arthurhpabreu/agentdeck/releases/tag/v0.8.1), com quatro pacotes de instalação, licença e checksums. Os testes das três plataformas e a conferência dos downloads estão registrados na [validação da release](../validation/0.8.1-release.md).

O plano reúne o cadastro de vaults globais selecionáveis, os seis ajustes escolhidos por Arthur, melhorias de performance e reorganização visual por arrastar em todas as listas de coleções. As entregas aproveitam worktrees, diffs, busca rápida, notificações, histórico e retomada já existentes.

## Vaults globais selecionáveis

Global significa cadastrado no catálogo da aplicação e disponível para escolha. O usuário pode criar itens com nomes livres, renomeá-los e selecionar nenhum, um ou vários vaults por projeto. OMA e Critical FPS são exemplos, sem categorias ou ambientes obrigatórios no produto. Cadastrar uma fonte não a ativa automaticamente nos projetos.

Cada conversa escolhe entre **Herdar seleção do projeto** e **Personalizar fontes desta conversa**. Uma seleção personalizada vazia significa nenhum vault global, sem fallback para herança ou para todas as fontes. Escolher fontes em um chat não muda as escolhas dos demais. Alterar o padrão do projeto atualiza as conversas que herdam esse padrão, com revisão da política; conversas personalizadas mantêm sua seleção.

Worktrees herdam o projeto canônico. Clones do mesmo remoto permanecem separados até associação explícita. Seleção, nome ou ordem visual de um projeto não alteram sua identidade nem suas fontes.

| Controle | Comportamento proposto |
| --- | --- |
| Catálogo global | IDs estáveis, nomes editáveis, caminhos configuráveis e suporte a vários vaults. |
| Seleção do projeto | Zero, um ou vários vaults, reutilizáveis em outros projetos quando escolhidos. |
| Seleção da conversa | Herança explícita ou combinação própria de fontes. |
| Preferências pessoais | Compartilhamento explícito e independente da seleção dos documentos. |
| Memória SQLite | Memória do projeto e coleções compartilhadas selecionáveis; escolher um vault não habilita todas as memórias globais. |
| Restrições opcionais | Pastas ou notas autorizadas dentro de um vault, aplicadas também a links e leitura direta. |

Um projeto pode selecionar um vault chamado OMA e outro selecionar Critical FPS. Um terceiro pode selecionar ambos, outra combinação ou nenhum. A autorização depende dos IDs selecionados, não do nome, da tecnologia usada ou da similaridade do conteúdo.

Cada fonte terá modo **Desativada**, **Disponível para consulta** ou **Contexto automático**. Disponível para consulta permite chamadas de ferramentas à fonte autorizada sem pré-carregamento automático; não exige um clique humano por consulta. Desativada impede os dois caminhos.

### Diagnóstico e correção de escopo

O diagnóstico abaixo registra o comportamento da base 0.7.0, antes dos ajustes de isolamento implementados no marco 0.8.

Hoje, a recuperação pode combinar a fonte do projeto com o vault global. Selecionar um vault próprio ou desmarcar apenas Usar preferências globais aprovadas não bloqueia toda inclusão global. A curadoria também pode promover uma preferência considerada geral ou recorrente em dois projetos. Esse desenho permite que trechos OMA entrem em Critical FPS quando houver correspondência; identificar entregas anteriores exige conferir registros de fontes.

Evidência: [documentos globais](../../src-tauri/src/knowledge.rs#L207), [recuperação conjunta](../../src-tauri/src/memory_retrieval.rs#L139), [filtro de preferências](../../src-tauri/src/shared_memory_intelligence.rs#L942) e [seleção automática](../../src-tauri/src/shared_memory_intelligence.rs#L824).

Implementar uma política única no backend, baseada em projeto/conversa, herança, IDs das fontes selecionadas, restrições e revisão. Aplicá-la antes da recuperação e em todos os caminhos: contexto automático, chats e terminais dos provedores, MCP, busca, leitura por ID, notas fixadas, relações, grafos, previews, links, curadoria e resumos de continuidade. Consultar outro projeto não pode ampliar silenciosamente as fontes da conversa solicitante.

Caches e respostas assíncronas devem respeitar projeto/conversa, seleção e revisão vigentes. Mudanças invalidam resultados antigos antes da entrega, inclusive em helpers já ativos. Identificadores de documentos incluem a fonte para distinguir caminhos iguais em vaults diferentes.

Captura automática permanece no projeto de origem. Compartilhar uma memória exige escolher explicitamente sua coleção e alcance. Repetição entre projetos não escolhe um destino global; promoção pessoal exige alcance universal explícito. A curadoria não escreve automaticamente nos Markdown originais dos vaults.

Migrar o vault global legado para um item de catálogo com nome editável e apresentar a seleção por projeto. Usar backup verificável, esquema versionado, rollback e reexecução idempotente. Fontes sem seleção definida permanecem disponíveis para administração, sem recuperação automática. Preservar notas, IDs, revisões e histórico; a migração altera associações do Agent Deck, sem mover, reescrever ou apagar o Obsidian.

Renomear preserva IDs e vínculos. Remover um item invalida suas seleções, sem excluir arquivos. Uma fonte removida ou indisponível não deve ser substituída silenciosamente por outro vault.

O painel de fontes existente passa a mostrar **Vaults selecionados**, herança ou personalização, origem, modo, motivo e estado preparado/enviado, com acesso ao seletor. Ele reflete a conversa aberta, mesmo quando outro projeto estiver selecionado na lateral.

A política controla o contexto fornecido pelo Agent Deck. MCPs externos, instruções nativas globais e acesso amplo ao filesystem precisam constar do diagnóstico; não são automaticamente isolados por essa seleção.

## Seis ajustes escolhidos

| Prioridade | Ajuste | Aplicação no Agent Deck | Esforço estimado |
| --- | --- | --- | --- |
| Alta | Atualizações e salvamentos mais econômicos | Atualizar apenas a sessão afetada; evitar serializar e gravar estados persistentes iguais durante streaming. | Médio |
| Alta | Controle do fluxo dos terminais | Rotear dados por sessão, agrupar saída em lotes e manter digitação e Cancelar responsivos sob carga, preservando todos os bytes. | Médio |
| Alta | Caixa Precisa de você | Reunir perguntas, bloqueios confirmados e conclusões não lidas; abrir a conversa correta e aproveitar notificações/filtros existentes. | Médio |
| Alta | Comentários no diff enviados ao agente | Selecionar linhas, comentar e enviar a revisão inteira em um único prompt, com arquivo e contexto. | Médio |
| Média | Navegação contextual | Expandir Ctrl/Cmd+K com arquivos, recentes, favoritos e prioridade para sessões que exigem ação. | Baixo a médio |
| Média | Recuperação mais clara | Distinguir histórico restaurado, sessão retomada e novo chat com contexto; oferecer checkpoints recuperáveis. | Médio a alto |

### Atualizações e salvamentos

Separar saída/status transitórios dos dados persistentes. Usar seletores por sessão/painel, deduplicar snapshots iguais e agrupar gravações numa fila serializada. Garantir revisão, ordenação e flush seguro em alterações importantes e encerramento; uma gravação antiga não substitui a mais nova. Preservar arquivo integral, falhas de armazenamento e mudanças confirmadas.

[Persistência espelhada](../../src/store/persistStorage.ts#L381), [estado de sessão](../../src/store/sessionStore.ts#L531) e [gravação nativa](../../src-tauri/src/ui_state.rs#L324) são os pontos iniciais. Saída e diffs já são excluídos da versão persistida; o alvo é o trabalho redundante ainda disparado por atualizações.

### Fluxo dos terminais

Criar roteamento compartilhado por sessão, lotes limitados e confirmação de consumo. Definir limites de fila e controle de fluxo mantendo entrada e Cancelar responsivos. Preservar bytes, ordem, Unicode e sequências ANSI; substituição de quadros visuais não permite descartar saída ou mensagens reais.

Separar o ciclo de vida do processo da interface antes de liberar views inativas: o cleanup atual pode encerrar o PTY. Preservar estado para restaurar a exibição sem reenviar prompts. [Cleanup/eventos](../../src/components/PtyTerminal.tsx#L255) e [leitura PTY](../../src-tauri/src/pty.rs#L407).

### Caixa de atenção

Integrar perguntas, aprovações, falhas acionáveis e conclusões não lidas à navegação direta por sessão. Mostrar estado, origem do evento e horário. Silêncio, heartbeat e histórico registrado não equivalem a conclusão ou bloqueio confirmado.

Preservar o requisito do aviso OAuth: somente erro novo, expiração após oito segundos e ausência de restauração pelo histórico. A caixa não deve persistir nem reativar esse banner passivo.

### Revisão pelo diff

Adicionar comentários por linha/faixa ao diff atual e envio em lote ao agente escolhido. Guardar revisão/hash do arquivo e sinalizar comentários cuja referência mudou. O prompt reúne arquivo, linhas, contexto e comentários, sem precisar copiá-los manualmente entre telas.

### Navegação contextual

Ampliar Ctrl/Cmd+K com arquivos, recentes, favoritos e prioridade de atenção. Ativar abas existentes em vez de duplicá-las. Abrir referências arquivo/linha no editor e enviar seleções como contexto. Congelar resultados durante a escolha e cancelar pesquisas substituídas. Consultas de conhecimento e recuperação de histórico para alimentar o agente respeitam a seleção da conversa; o histórico original continua acessível ao usuário.

### Recuperação

Mostrar claramente o que foi restaurado: histórico/layout, sessão nativa do provedor ou nova conversa com contexto. Criar checkpoints recuperáveis com versões e retenção, mantendo o arquivo integral e as decisões de projeto.

Mudança de seleção não remove trechos já enviados ao modelo. Oferecer **Novo chat com fontes corretas**, usando nova identidade no provedor e resumo revisado dentro da seleção atual. Preservar a conversa original para o usuário; não anexar automaticamente seu arquivo integral ao novo agente. Conteúdo antigo sem proveniência suficiente exige revisão antes de entrar no resumo.

## Reorganização por arrastar e melhorias de exibição

A ordem manual deve ser uma preferência estável de apresentação. Selecionar um item, receber streaming ou atualizar o estado do agente não pode reordenar automaticamente uma lista configurada pelo usuário. Separar foco/z-order, ordem manual, agrupamento visual e dados reais da execução.

| Superfície | Ajuste de reorganização e exibição |
| --- | --- |
| Projetos | Arrastar para ordenar a navegação e grupos visuais; selecionar um projeto mantém a ordem escolhida. |
| Conversas e sessões | Ordem manual livre dentro do projeto, incluindo itens com estados diferentes; preservar a opção de ordenação automática. |
| Abas de terminal e editor | Ordenar abas e grupos visuais com interação consistente; aproveitar os recursos existentes no editor. |
| Agentes e subagentes | Arrastar itens/grupos nas listas e cartões no mapa/quadro; ordenar filhos e salvar posições visuais. Manter a hierarquia real e os vínculos visíveis. |
| Arquivos e diffs | Ordenar a sequência visual de navegação/revisão, preservando caminhos e conteúdo reais. |
| Vaults, fontes e notas | Reordenar seletores, fontes escolhidas e listas de consulta; ordenação não habilita uma fonte. |
| Atenção, favoritos, recentes e resultados | Oferecer organização manual nas coleções, com retorno à ordem calculada. Preservar estado, datas e relevância originais. |

Inventariar todas as superfícies de coleções e aplicar o comportamento consistente, incluindo listas filtradas e virtualizadas. Eventos e mensagens continuam registrados cronologicamente; seus grupos e painéis podem ser organizados sem alterar a sequência original do histórico.

A ordem manual usa IDs estáveis e persiste por superfície/contexto, separada da política de fontes e do estado de execução. Filtros preservam a posição dos itens ocultos. Novos itens entram de forma previsível; renomear ou atualizar um item mantém sua posição. Reiniciar a aplicação restaura ordens e posições.

Arrastar altera a ordem e a posição visual, preservando arquivos/repos no disco, projeto proprietário, diretório/worktree, seleção de vaults, processos e parentesco real dos subagentes. Agrupamentos manuais devem mostrar os estados e vínculos reais. Colunas calculadas por status mantêm seu significado; a visão manual permite organização livre sem simular uma mudança de execução.

Adicionar alça identificável, indicação de destino, auto-scroll, limiar contra arrasto acidental, Escape para cancelar, desfazer e restaurar ordem/layout automático. Oferecer alternativa por teclado para mover antes/depois, sem exigir mouse. Nos mapas, considerar zoom/pan ao calcular posições.

Melhorar hierarquia e indentação de agentes/subagentes, nomes longos, distinção entre seleção e execução, densidade ajustável e leitura em janelas menores. Manter texto junto de ícones/cores, foco acessível, temas e EN/PT/ES. Persistir no fim do arrasto, sem gravar cada pixel.

Situação atual: projetos selecionados podem mudar de ordem via [bringToFront](../../src/components/WorkspaceStack.tsx); sessões já têm arraste com restrições por prioridade de status; o editor já permite ordenar abas e grupos. Completar e padronizar esses recursos. Lista/quadro/mapa de agentes e abas de terminal precisam entrar na cobertura.

## Melhorias de performance transversais

Limitar a retenção de interfaces ocultas, preservando rascunhos, seleção, rolagem e processos. Avaliar blocos Markdown estáveis durante streaming, carregamento sob demanda, listas/diffs virtualizados e atualização apenas dos itens afetados. [Sessões mantidas montadas](../../src/components/SessionDetail.tsx#L498) são um ponto inicial.

O arraste deve permanecer fluido durante streaming, buscas e atualizações de estado. Evitar renderizar todas as listas durante a movimentação; confirmar a ordem apenas no término. A ordem e os cartões não podem saltar sob o cursor devido à telemetria.

Criar linha de base e comparar as mesmas cargas na mesma máquina: chats de 10–20 MiB, 5/20/50 sessões acumuladas, 4–8 streams sintéticos, colagem grande, diffs extensos e arrastes com filtros/virtualização. Medir CPU/memória, gravações e eventos por segundo, tamanho de filas, renderizações React e latência p50/p95 de digitação, Cancelar, troca de sessão e movimentação.

Fixar metas após medir a linha de base. Aceitar cada otimização com melhora demonstrada na métrica alvo e preservação exata dos dados. Separar memória do app, WebView e processos dos agentes.

## Ordem de execução e critérios de aceite

| Ciclo | Entregas | Aceite |
| --- | --- | --- |
| 1 | Vaults selecionáveis, política de contexto, migração e transparência. | Apenas fontes escolhidas entram por contexto automático, MCP, ID, links, cache e curadoria; herança e seleção vazia funcionam. |
| 2 | Atualizações/salvamentos e fluxo dos terminais, com medição inicial. | Menos trabalho redundante; bytes íntegros; digitação/Cancelar responsivos e recuperação de gravações. |
| 3 | Reorganização por arrastar e exibição em todas as coleções. | Ordem persistente e livre na visão manual, teclado/mouse, subagentes organizáveis e identidade/processos/contexto preservados. |
| 4 | Caixa de atenção e navegação contextual. | Eventos confirmados, salto à sessão certa, favoritos/recentes e buscas sem resultados ou ordenações inesperadas. |
| 5 | Comentários no diff e recuperação/checkpoints. | Revisão enviada em lote; referências desatualizadas sinalizadas; histórico e retomada apresentados corretamente. |

Casos de regressão obrigatórios:

- Vaults com nomes livres, zero/um/vários selecionados, compartilhamento escolhido entre projetos e seleção personalizada vazia.
- Fontes com termos iguais; IDs conhecidos, notas fixadas, wikilinks, previews e caches sem recuperar uma fonte não selecionada.
- Alteração de seleção durante execução, reinício/compactação e migração interrompida, sem modificar os arquivos do Obsidian.
- Arraste entre itens com estados diferentes, agentes/subagentes, listas filtradas, coleções virtualizadas e streaming simultâneo.
- Clique/foco sem alterar ordem, renomeação/reinício preservando posições e cancelamento/desfazer de arraste.
- Reordenação visual sem mudar projeto, diretório, worktree, seleção de vault, vínculo de subagente ou histórico original.
- PTY com Unicode/ANSI divididos, saída intensa, sessões ocultas e Cancelar, mantendo todos os bytes e sua ordem.
- Falha de gravação e encerramento durante persistência agrupada, sem perder alterações confirmadas.
- Aviso OAuth expirando em oito segundos, sem reaparecer na caixa de atenção ou no histórico.
- Teclado/mouse, temas, EN/PT/ES e Windows/Mac Intel/Apple Silicon.

Os testes usam fixtures sem prompts pagos ou notas privadas. Cada implementação passa pelos checks adequados e pelo CI nativo existente. Manter uma versão SemVer sincronizada para Windows/macOS; novos fluxos e catálogo de vaults são funcionalidades minor, e correções/otimizações compatíveis podem ser patch. Mudanças de esquema exigem migração e compatibilidade documentadas.

## Revisão de usabilidade e distribuição de modelos — 15 de outubro de 2026

As [notas da versão 0.10.0](../releases/0.10.0.md) e a [validação da release](../validation/0.10.0-release.md) registram as mudanças desta revisão, entregues na [release publicada](https://github.com/arthurhpabreu/agentdeck/releases/tag/v0.10.0).

O estudo desta revisão usou a tela existente, os fluxos de seleção de fontes e capturas com dados sintéticos em temas claro/escuro, lateral de 330 px e janelas de 1360×900 e 1024×768. A dificuldade principal era a mistura de cadastro, autorização, consulta e diagnóstico na mesma sequência. O cadastro global continuava necessário como catálogo reutilizável; o nome “Global” induzia a interpretar que as fontes seriam usadas em todas as conversas.

| Problema observado | Decisão implementada |
| --- | --- |
| Alças pontilhadas exigiam acertar um alvo pequeno. | Segurar o corpo do item inicia o arraste. Clique, seleção de texto, campos, links e ações mantêm sua função. Toque permite rolar antes da ativação; teclado, cancelamento e desfazer continuam disponíveis. |
| A lateral tinha um limite fixo de 560 px. | O limite acompanha metade da janela, com redimensionamento por mouse ou teclado e preferência salva ao concluir o gesto. |
| A área inicial de Conhecimento priorizava memória e explicações técnicas. | Documentos passa a ser a entrada inicial. A aba escolhida permanece ao reabrir o painel durante a sessão. |
| “Global” misturava cadastro com fontes autorizadas. | Documentos separa **Fontes** da conversa/projeto e **Catálogo de vaults**. Cadastrar um vault não o seleciona; herança e seleção vazia continuam explícitas. |
| Caminhos, revisões, restrições, coleções e diagnóstico ocupavam a primeira leitura. | Metadados e configurações ficam em detalhes. Busca fica antes de grafo/diagnóstico, que só são carregados quando abertos. |
| Mensagens de renovação OAuth do Miro eram promovidas a avisos de login. | Renovação opcional de inicialização vira diagnóstico sanitizado, consultável em Detalhes da execução. Erros explícitos de autenticação continuam acionáveis. |

Na fixture de comparação, o primeiro checkbox de vault passou de aproximadamente 630 px para 475 px de altura; a busca passou a aparecer na janela de 1360×900. As capturas locais de antes/depois ficam em `.local/knowledge-ui`, sem dados privados incluídos no repositório. As mudanças de apresentação não alteram IDs, autorização de fontes, herança, migração ou o significado de uma seleção vazia.

### Modo econômico com vários modelos

O painel **Economia de tokens**, que já reúne RTK e uso reportado pelo provedor, ganhou a opção independente **Distribuir tarefas entre modelos**, desativada inicialmente. Ela funciona sem instalar RTK. No ajuste de comportamento de 15/10, as próximas execuções preservam o modelo, o esforço e as opções Fast e Ultra escolhidos pelo usuário; os controles existentes continuam utilizáveis. A economia se aplica às tarefas auxiliares delegadas a Luna/Haiku, com assessoria forte pontual. A opção não muda processos já em andamento.

| Provedor | Coordenação | Exploração delimitada | Assessoria pontual |
| --- | --- | --- | --- |
| Codex | Modelo escolhido pelo usuário. | Luna disponível, esforço baixo; até três subagentes simultâneos como limite nativo. | Astra ou Sol disponível compatível, esforço alto, para consultas pontuais. |
| Claude Code | Modelo escolhido pelo usuário. | Haiku resolvido, agente de consulta sem ferramentas de edição, até oito turnos; esforço baixo quando suportado. | Opus: assessor nativo apenas em pares explicitamente selecionados e conhecidos como compatíveis; nos demais casos, subagente de revisão somente leitura. |

A escolha dos auxiliares usa o catálogo real do CLI, sem enviar prompts pagos para descobri-lo. O catálogo é cacheado por CLI e contexto de execução, independentemente do modelo escolhido; o perfil é resolvido por sessão. Os controles nativos atuais foram conferidos nas versões instaladas Codex 0.162.1 e Claude Code 2.1.300; versões anteriores não são declaradas compatíveis por suposição. Configurações ficam nos argumentos/ambiente de cada processo. Arquivos globais dos provedores, permissões, sandbox e configuração MCP do usuário são preservados. A orientação é evitar delegação em tarefas simples, usar investigações independentes com resumos curtos e reservar o assessor para decisões importantes ou falhas recorrentes. No chat, a orientação só é registrada como entregue depois da confirmação do provedor, sem repetição a cada mensagem; desativar revoga apenas as instruções de distribuição do Agentdeck.

No Claude Code, Fable, modelos customizados e a escolha padrão (`default`) usam um subagente Opus de revisão somente leitura, com um brief curto contendo apenas o contexto necessário à consulta. O recurso nativo `--advisor` fica restrito aos pares explicitamente selecionados e cuja compatibilidade seja conhecida. O modelo principal escolhido pelo usuário é preservado em todos esses caminhos.

As funções dos modelos seguem a [orientação oficial de seleção da OpenAI](https://learn.chatgpt.com/docs/model-selection) e os [controles de subagentes do Codex](https://learn.chatgpt.com/docs/agent-configuration/subagents). Para Claude, são usados os controles documentados de [subagentes](https://code.claude.com/docs/en/sub-agents) e [advisor](https://code.claude.com/docs/en/advisor), sem presumir que `--subagents` seja um argumento aceito.

No terminal nativo, um sufixo de instruções do processo mantém a orientação disponível para digitação direta e depois de `/clear` ou `/compact`, sem criar um turno pago de inicialização. Claude preserva o sufixo existente, inclusive quando veio de arquivo; Codex consulta apenas `config/read` para preservar o valor efetivo de `developer_instructions` antes de acrescentar o novo trecho. Perfis nativos explícitos, troca de diretório por flags, execução remota ou configurações cujo resultado não possa ser comprovado não recebem uma substituição presumida: o modo ligado solicita usar a conversa legível ou retirar a combinação incompatível. Desligar o modo mantém a possibilidade de lançar esses terminais e conserva a revogação pendente para o próximo envio pela interface.

Distribuir tarefas entre modelos não comprova redução da quantidade de tokens. Por isso, a interface mantém as estimativas medidas pelo RTK separadas do uso informado pelo provedor e mostra a economia da distribuição como **sem estimativa** até existir uma comparação confiável. O assessor nativo Claude depende da disponibilidade do provedor e suas consultas acrescentam consumo; o [advisor processa o histórico completo sem reutilizar cache próprio](https://code.claude.com/docs/en/advisor#impact-on-prompt-caching). Preços de API também não são convertidos em economia de assinatura, conforme a [documentação de uso e preços do Codex](https://learn.chatgpt.com/docs/pricing).

### Validação desta revisão

- Validação final da 0.10.0: **11 de 11 testes Chromium locais** passaram para confiabilidade e ciclo de vida do chat. O CI da tag aprovou **235 testes Chromium no Windows**, **29 testes WebKit no Mac Apple Silicon** e **29 no Mac Intel**, além dos testes nativos e das verificações dos pacotes. Resultados completos, hashes e conferência pública constam na [validação da release](../validation/0.10.0-release.md).
- Correção de encerramento do chat: resultados Claude reconciliam os UUIDs de mensagens consumidas e o estado nativo da sessão. O fechamento da entrada e a limpeza do transporte têm critérios separados; comandos em segundo plano e agentes reais permanecem protegidos. A interface identifica a espera por tarefas em segundo plano e não reabre ferramentas concluídas por eventos de progresso atrasados. A suíte nativa completa aprovou 276 casos, com sete opcionais ignorados; após o último ajuste de EOF, os 72 testes de chat passaram. O CI da release registra a validação final por plataforma.
- Backend Windows: **263 testes aprovados**, nenhum erro e sete testes opcionais ignorados. Inclui preservação de permissões/instruções, modelo/esforço/Fast/Ultra principais em execuções novas e retomadas, flags antes do separador de prompt, seleção de auxiliares, deduplicação/revogação, compactação e classificação OAuth.
- Interface Chromium: a rodada completa aprovou **224 de 228** casos. Os quatro restantes excederam o prazo ao carregar módulos lazy sob pressão de recursos, antes de executar as ações avaliadas. A repetição com um único runner aprovou **20 de 20**, incluindo todos os 17 casos de ordenação e os três fluxos restantes, sem aumentar timeouts nem retirar asserções. A cobertura total compreende **229 cenários distintos**, incluindo a regressão adicional de arraste de label sem alterar seu checkbox.
- TypeScript, build de produção, traduções EN/PT/ES, higiene do repositório, versões sincronizadas, formatação Rust e `git diff --check` verificados. Os avisos já existentes de tamanho de chunks/importação mista do Vite permanecem.
- Inicialização e metadados dos CLIs reais validados sem `thread/start`, sem `turn/start` e sem prompts pagos. Isto valida compatibilidade da configuração; não mede economia financeira nem garante acesso ao assessor no provedor.
- Após o ajuste de preservação do modelo principal, **14 de 14 testes Chromium** passaram: nove de economia e cinco de seleção/esforço/velocidade, incluindo a requisição efetiva com economia ligada e troca de modelo. Metadados dos CLIs reais aceitaram Astra com Ultra/Fast e explorador Luna baixo, Opus com Max/Fast/Ultracode e assessor nativo, e Fable com Max/Fast/Ultracode e assessor por subagente; nenhum turno de modelo foi enviado. Relatório: `.local/validation/economy-selection-report.json`; captura: `.local/validation/economy-main-selection.png`.
- Capturas de Conhecimento, economia e detalhes de execução inspecionadas; laterais de 800 px em janela de 1600 px e de 250 px em janela de 500 px conferidas. Relatórios sintéticos locais: `.local/validation/final-ui-report.json` e `.local/validation/final-focus-report.json`.

## Referências

- Orca: [revisão em lote](https://www.onorca.dev/docs/review/annotate-ai-diff), [atenção](https://www.onorca.dev/docs/notifications), [navegação](https://www.onorca.dev/docs/model/quick-open), [persistência serializada](https://github.com/stablyai/orca/blob/38255300d90059631996e4d836acaf220958058e/src/main/persistence/atomic-snapshot-writer.ts).
- Herdr: [histórico e retomada](https://herdr.dev/docs/session-state/), [coalescência de renderização](https://github.com/herdrdev/herdr/blob/916fcf8de029c6cac965b50f3cdb9687cd7d1537/src/render_signal.rs).

As referências orientam os mecanismos escolhidos; os ganhos de performance do Agent Deck serão validados em suas próprias cargas.
