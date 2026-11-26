# ADR 0043 — Agentes de IA nos tickets: MCP com escrita e marcador de trabalho

**Status:** Proposta da coordenação a partir do pedido de Teodoro em 2026-11-22: "quero que tickets em progresso pela IA tenham um contorno tracejado animado que fica 'andando' em volta do card. traço um pouquinho grosso" e "o servidor mcp deveria aceitar atualizações nos tickets também, assim vc pode interagir com ele pra informar progresso, notas etc". O objetivo é dele; o desenho abaixo é escolha da coordenação e vale até ele dizer o contrário. Não vai ao `main` sem uma revisão de segurança independente, como as duas fatias de leitura. **Data:** 2026-11-22.

Altera a [ADR 0038](0038-servidor-mcp-por-projeto-com-token-por-pessoa.md), que fez o servidor MCP só de leitura, e acrescenta um sinal visual à [ADR 0025](0025-base-visual-constelacao-e-tema-do-mapa.md).

## Contexto

- O servidor MCP de hoje tem quatro ferramentas de leitura, token de uma pessoa para um projeto, chave por organização e limites por token e por endereço (ADR 0038). A tela de tokens diz que o acesso é só de leitura.
- As regras de ticket (concluir com filho aberto, reabertura do pai, o que uma ideia permite) estão em parte dentro do controlador HTTP de tickets. Uma segunda porta de escrita que não passe por elas criaria um caminho que contorna as regras.
- O mapa busca os tickets ao abrir e depois de cada alteração feita na própria tela. Não se atualiza sozinho: o que outra pessoa ou um agente muda só aparece ao recarregar.
- A coordenação já registra o trabalho no projeto `TREEPM` por uma ferramenta de linha de comando que age como o usuário de Teodoro. Ela não informa andamento durante o trabalho.

## Decisão

### Escrita é uma permissão do token, desligada por padrão

- O token ganha um **alcance**: `leitura` (padrão) ou `leitura e escrita`, escolhido ao criar e mostrado na lista. **Todo token que já existe continua só de leitura.** O alcance não muda depois; para escrever, cria-se outro token.
- A organização ganha uma segunda chave, **"Permitir escrita por MCP"**, desligada por padrão e ligada só por administrador. Com ela desligada, nenhum token escreve, qualquer que seja o alcance.
- Um token de escrita só escreve o que a pessoa dele poderia escrever pela tela: os papéis dela no projeto valem a cada chamada.

### Três ferramentas de escrita, e nenhuma leitura nova

| Ferramenta | Faz |
| --- | --- |
| `update_ticket_status` | Muda a situação de um ticket |
| `add_comment` | Escreve um comentário no ticket (do ticket, não de área) |
| `set_agent_work` | Liga, renova ou desliga o marcador de trabalho pela IA |

- Só aparecem na lista de ferramentas de um token de escrita.
- **Escrever comentário não abre a leitura de comentários:** as ferramentas de leitura continuam sem devolver comentários, histórico nem texto de áreas (`TREEPM-93` segue sendo decisão de Teodoro).
- Criar, mover, renomear e apagar ticket, mexer em pessoas, áreas, dependências e ideias ficam fora. Entram depois, uma a uma, se fizerem falta.

### As mesmas regras da tela

As regras de ticket que hoje vivem no controlador HTTP passam para um serviço só, usado pelas rotas e pelo MCP. Não há regra escrita duas vezes. A mesma lista de recusas é testada pelas duas portas: leitor do projeto, projeto arquivado, concluir com filho aberto, ticket dentro de ideia, projeto de outra organização.

### Quem fez fica visível

- Todo evento gravado por uma chamada MCP guarda que veio do MCP e por qual token.
- No histórico do ticket, a entrada mostra "pelo MCP" ao lado do nome da pessoa do token; o comentário escrito pelo MCP mostra a mesma etiqueta. Assim o que um agente fez nunca se confunde com o que a pessoa fez à mão.

### Marcador de trabalho pela IA

Um sinal de que um agente está trabalhando naquele ticket agora. **Não é uma situação** e não muda nenhuma regra.

- **Liga-se só pelo MCP**, com token de escrita, e vale por um tempo: de 5 a 240 minutos, 60 por padrão. Chamar de novo renova. Passado o prazo o marcador deixa de valer sozinho, sem ninguém limpar: um agente que morreu não deixa o contorno andando para sempre.
- **Desliga-se** pela mesma ferramenta, ao concluir ou cancelar o ticket, ou por qualquer pessoa que possa editar o ticket, na página dele ("Encerrar").
- **Recusado** em ticket concluído ou cancelado e em ideia ou ticket dentro de uma (uma ideia não é trabalhada antes do aceite).
- Pode levar uma nota curta, de até 200 caracteres ("escrevendo os testes"), que aparece na página do ticket.
- Ligar o marcador não muda a situação: o agente que quer passar o ticket para "em andamento" chama a outra ferramenta.
- Ligar, renovar e desligar gravam evento; o histórico mostra ligar e desligar, não cada renovação.

### O contorno no mapa

Enquanto o marcador vale, o card do ticket ganha um **contorno tracejado animado, que anda em volta do card**, com 2 px de espessura, na cor do nó.

- Aparece em todo nível de detalhe em que o ticket é um card. No nível de ponto, o quadrado pulsa devagar.
- É diferente do card tracejado do rascunho da conversa com a IA, que é parado, fino e não é ticket.
- Com "reduzir movimento" ligado no sistema, o tracejado fica parado.
- **Nada mais muda no mapa:** um teste de instantâneo garante que uma árvore sem marcador é desenhada como antes.
- O ticket pai não mostra o contorno por ter um filho em trabalho.

### O mapa se atualiza sozinho

Sem isso o contorno só apareceria ao recarregar. Com a aba visível, o mapa busca de novo os tickets a cada 30 segundos e ao voltar para a aba; com a aba escondida, não busca. É a forma mais simples que resolve; o custo em projeto grande é medido no `TREEPM-191`, e uma troca por envio do servidor fica em aberto.

### Limites e conferências

- Limite próprio para escrita: 20 chamadas por minuto por token, além dos limites que já existem.
- Uma requisição com várias chamadas juntas não pode conter escrita: é recusada inteira.
- **Toda escrita confere de novo** se a pessoa do token ainda está na organização, sem usar a memória de 5 minutos que a leitura usa.
- O corpo do comentário e a nota do marcador nunca entram em log.

### Ideias, para o MCP e para a pergunta sobre o projeto

Entra junto, porque um agente que escreve precisa enxergar direito o que é trabalho (fatia 5 da [ADR 0042](0042-ideias-na-arvore.md), `TREEPM-108`): cada ticket lido diz se é ideia ou parte de uma; o resumo do projeto conta as ideias à parte, fora da contagem por situação; e a procura do lugar para um ticket novo deixa de considerar ideias.

### Como a coordenação usa

Teodoro cria um token de escrita para o projeto `TREEPM` e o liga à sessão da coordenação; ninguém além dele cria esse token. A coordenação liga o marcador no ticket da fatia ao abrir um executor, escreve um comentário com o andamento nos pontos que importam e desliga o marcador ao mesclar. A situação do ticket só passa a "concluído" depois de o PR estar mesclado.

### Banco (migration `0019`)

- `access_tokens`: o alcance.
- `organizations`: a chave de escrita por MCP.
- `tickets`: desde quando, até quando e por qual pessoa o marcador vale, e a nota.
- Eventos de atividade: a origem MCP e o token ficam no conteúdo do evento; a tabela não muda.

## Fatias

1. **Regras num serviço só**, sem mudar comportamento, e o marcador no ticket (banco, leitura, encerrar pela tela).
2. **MCP com escrita:** alcance do token, chave da organização, as três ferramentas, limites, autoria, e as ideias para a IA.
3. **Web:** contorno animado, mapa que se atualiza, alcance na tela de tokens, "pelo MCP" no histórico, marcador na página do ticket.
4. **Revisão de segurança independente**, antes do merge das fatias 1 e 2.

## Alternativas descartadas

- **Marcador como situação nova ("em andamento pela IA").** Toda regra que lê situação teria de aprender mais um valor, e o ticket perderia a situação real enquanto o agente trabalha.
- **Todo token passa a escrever.** Quebra o que a ADR 0038 e a tela prometeram a quem já criou token.
- **O MCP chamar as rotas HTTP por dentro.** Passaria pelas regras, mas com a autenticação errada e sem como marcar a autoria.
- **Marcador sem validade.** Um agente interrompido deixaria o ticket marcado até alguém notar.
- **Atualização por envio do servidor já agora.** Mais infraestrutura do que o problema pede hoje; fica para quando a medição mostrar que a busca periódica pesa.

## Em aberto

1. Quais outras escritas o MCP deve ganhar (criar ticket, mover, pessoas).
2. Leitura de comentários e de áreas pelo MCP (`TREEPM-93`).
3. Se a busca periódica do mapa aguenta projetos grandes (`TREEPM-191`, `TREEPM-192`).
4. OAuth no MCP, que a ADR 0038 já deixou em aberto.

## Como ficou (PRs #142, #143, #148 e #152, 2026-11-22)

- **Banco (migration `0019`):** `tickets.agent_work_*` (desde, até, nota e quem ligou), `access_tokens.scope` (padrão `read`), `organizations.mcp_write_enabled` (padrão desligado) e, em `ticket_comments`, `via`, `request_token_id` e `request_id`. A migration `0020` trocou as permissões de `UPDATE` em `access_tokens` e `organizations` por permissões por coluna.
- **Uma regra só:** as regras de mudança de ticket saíram do controlador para `TicketsService.updateTicket`, e a tela e o MCP passam por ela. O MCP não tem caminho próprio de escrita.
- **Ferramentas de escrita do MCP:** `update_ticket_status`, `add_comment` (com `requestId` opcional, para repetir sem duplicar) e `set_agent_work`. Só respondem com token de alcance de escrita **e** com a chave da organização ligada; sem um dos dois, a ferramenta recusa.
- **Rotas da tela:** `PATCH /api/organization/mcp-write` com `{ mcpWriteEnabled }` (administrador) e `DELETE /api/tickets/:id/agent-work` (uma pessoa encerra o marcador).
- **Leitura:** as ferramentas de leitura devolvem só `agentWork: { until } | null`; a nota do marcador não sai pelo MCP nem vai à IA.
- **Histórico:** `agent_work_started` e `agent_work_ended`, este com o motivo `agent`, `person`, `finished`, `idea` ou `archived` (arquivar o projeto encerra os marcadores dele).
- **Limite:** 40 escritas por minuto por pessoa, somando os tokens dela.
- **Web:** o contorno é um `<svg>` com um retângulo de cantos arredondados e `stroke-dashoffset` animado por CSS (`map/agent-work.css`), que acompanha o raio do card em todos os níveis de detalhe; no nível de ponto é um halo que pulsa; parado com `prefers-reduced-motion`. A primeira versão, de quatro faixas de degradê, tinha cantos retos (`TREEPM-199`). O mapa se atualiza a cada 30 s (`map/useAutoRefresh.ts`). Em Configurações, o alcance do token e a chave "Permitir escrita por MCP".
- **Revisão de segurança independente**, feita antes do merge da escrita: todos os achados foram corrigidos antes de entrar no `main`, e o endurecimento que restou entrou no PR #148 (permissões por coluna, limite por pessoa, marcadores encerrados ao arquivar).
- **Não foi exercitado** com um cliente MCP de verdade escrevendo (`TREEPM-189`, `TREEPM-227`): depende de Teodoro ligar a chave e criar um token de escrita. Só ele cria esse token.

## Adendo de 2026-11-23: a fila de trabalho, a prioridade e a criação de tickets pelo MCP (`TREEPM-258`)

Decisão da coordenação, por delegação de Teodoro em 2026-11-23; reversível. Resolve o item 1 de "Em aberto" desta ADR e o item 1 da ADR 0047.

Um agente hoje consegue ler o projeto, comentar, mudar situação e ligar o marcador, mas não sabe **o que pegar** e não consegue **registrar o que descobre**. Três ferramentas fecham o ciclo "pegar, trabalhar, relatar, registrar":

- **`get_work_queue` (leitura):** a fila "próximos para trabalhar" da ADR 0047, para a pessoa dona do token, no projeto do token e, se pedido, dentro de um ramo. Devolve os tickets na ordem da fila, com a prioridade que vale e o caminho, e, quando vazia, o motivo. É a mesma função do domínio que a tela usa: agente e pessoa veem a mesma fila. Ticket com marcador de outro agente não entra, como na tela.
- **`set_ticket_priority` (escrita):** muda a prioridade pelo mesmo caminho da tela (`TicketsService.updateTicket`), com o evento de histórico marcado como feito pelo MCP.
- **`create_ticket` (escrita):** cria um ticket com título, descrição e, opcionalmente, pai e prioridade; pode nascer como ideia (`idea: true`), pelas mesmas regras e permissões da tela. O lugar é escolhido por quem chama: a procura por IA não é acionada pelo MCP. Aceita `requestId`, como `add_comment`, para repetir sem duplicar.

Valem para as três de escrita as regras que já existem: token de alcance de escrita **e** a chave da organização ligada; limite de 40 escritas por minuto por pessoa; autoria "pelo MCP" visível no histórico; nenhuma regra de negócio própria do MCP (tudo passa pelos serviços da tela, inclusive a trava de estrutura da ADR 0045 e a versão do projeto da ADR 0046). Nada novo vai a provedor de IA.

Continuam fora: mover ticket, mudar título e descrição de ticket existente, atribuir pessoas, aceitar ideia, remover. Cada um entra quando houver uso que o peça.

Como é escrita nova por um canal de máquina, passa por revisão de segurança independente antes de entrar.

### Como ficou o adendo (PR #177, 2026-11-23)

- As três ferramentas existem: `get_work_queue`, `set_ticket_priority` e `create_ticket`. A fila vem da mesma função do domínio que a tela usa (`workQueue`).
- `create_ticket` passa por `TicketsService.createChecked`, o mesmo caminho da tela. Com `requestId`, repetir o chamado do mesmo token em até 10 minutos devolve o ticket já criado: o evento de criação guarda um resumo do pedido (`requestDigest`), e o mesmo `requestId` com conteúdo diferente é recusado com 409 `request_id_reused`.
- Token só de leitura deixou de gastar o limite de escritas da pessoa.
- A revisão de segurança independente foi feita antes do merge e os achados, todos menores, foram corrigidos no mesmo PR.
- Não foi exercitado com um cliente MCP de verdade: depende do token de escrita, que só Teodoro cria (`TREEPM-189`).
