# ADR 0045 — Mudanças de estrutura da árvore são serializadas por projeto

- **Data:** 2026-11-22
- **Estado:** proposta da coordenação, pelos padrões que Teodoro aceitou em 2026-11-22; implementação em `TREEPM-30`.

## Contexto

A árvore de tickets não pode ter ciclo. Hoje a conferência de ciclo é feita dentro de cada requisição: ela lê os ancestrais do pai novo e recusa se o ticket movido estiver entre eles. Duas requisições ao mesmo tempo, no mesmo projeto, não se enxergam: uma move A para dentro de B enquanto a outra move B para dentro de A, cada uma vê uma árvore válida, e as duas gravam. O resultado é um ciclo, que tira os dois ramos do mapa e quebra tudo o que sobe pelos pais (progresso, raiz de ideia, caminho).

O risco cresce com o que já entrou: agentes escrevendo pelo MCP, a conversa que cria pai e filhos, a importação e a procura que move tickets.

O mesmo vale para as regras que leem a árvore antes de gravar: mover para dentro de uma ideia confere a situação dos descendentes (a ADR 0042 registrou esse risco residual), e a criação de pai com filhos supõe que o lugar escolhido continua onde estava.

## Decisão

Toda transação que **muda a estrutura** da árvore de um projeto pega, logo no começo, uma trava exclusiva daquele projeto, que dura até o fim da transação. Quem chega depois espera, e faz as suas conferências já enxergando o que a anterior gravou.

- **Mecanismo:** trava consultiva do PostgreSQL por transação (`pg_advisory_xact_lock`), com a chave derivada do identificador do projeto, num espaço de chaves próprio para "estrutura do projeto". Não bloqueia leituras nem edições que não mexem na estrutura (título, descrição, situação, pessoas, comentários).
- **O que conta como mudança de estrutura:** trocar o pai de um ticket, criar ticket com pai, remover ticket, transformar em ideia, aceitar ou descartar ideia, importar tickets, criar a partir da conversa (pai, filhos e agrupador), e qualquer escrita da procura que mova tickets.
- **Um lugar só:** a trava é pega por uma função única, chamada pelos serviços; nenhum controlador a pega por conta própria. Um teste percorre o código e falha se uma escrita de `parent_id` acontecer fora de uma transação que passou por ela.
- **Mover entre projetos** pega as duas travas, sempre na mesma ordem (pela chave), para não haver espera cruzada.
- **Espera limitada:** a transação desiste depois de alguns segundos de espera e a API responde com um erro de conflito que a tela já sabe mostrar ("tente de novo"), em vez de segurar a requisição.
- **Defesa no banco:** se for barato, um gatilho que recusa a gravação de um `parent_id` que fecha ciclo, como segunda barreira. Se o custo em árvores grandes não for aceitável, fica registrado aqui por que não entrou.

## Alternativas descartadas

- **Isolamento serializável nas transações.** Resolve, mas faz qualquer transação poder falhar por conflito e exige repetição em todo lugar.
- **Travar a linha do projeto (`SELECT … FOR UPDATE`).** Funciona, mas disputa com quem edita o próprio projeto (nome, membros) sem necessidade.
- **Só o gatilho de ciclo.** Protege contra o ciclo, não contra as outras regras que leem a árvore antes de gravar.

## Em aberto

1. Se a espera limitada precisa de repetição automática no servidor antes de devolver o conflito.
2. Medir o custo da trava com muitos agentes escrevendo no mesmo projeto (`TREEPM-191`).

## Como ficou (2026-11-22)

- **Função única:** `lockProjectStructure(tx, projectId)` em `apps/api/src/tickets/structure-lock.ts`, com `pg_advisory_xact_lock(hashtextextended('ticket-structure:' || projeto, 0))`. Chamada antes de qualquer conferência que leia a árvore; o ticket é relido depois da trava.
- **Onde entra:** trocar pai (só quando o pedido traz pai; título, situação e pessoas não esperam), criar com pai, criar pai e mover, importar, remover, transformar em ideia, aceitar e descartar, e a criação pela conversa (pai, filhos e agrupador). O MCP hoje só escreve situação, comentário e marcador, que não mudam estrutura. A procura só lê.
- **Mover entre projetos não existe** no produto, então não há trava dupla.
- **Espera limitada e prazo da transação (revisão 1):** a espera pela trava é de 3 s (`lock_timeout` só durante a espera). O prazo da transação interativa do Prisma 7 era o padrão de 5 s; passou a 15 s (`tenantTransaction` em `@treepm/db`, usado por `withTenant`), cinco vezes a espera, para quem consegue a trava no último instante ainda ter orçamento. Efeito fora da estrutura: qualquer transação de requisição pode durar até 15 s em vez de 5 s antes de ser fechada (só afeta quem já estaria falhando). Estourou a espera: 409 `structure_busy`; estourou o prazo da transação depois de pegar a trava: também 409 `structure_busy`, não 500. Frase própria na web nos três idiomas.
- **Impasse entre travas de linha (revisão 1):** `lockSubtree` trava por ordem de id e a mudança de situação trava de baixo para cima (`reopenAncestors`); as ordens não se unificam de forma barata, então o impasse (40P01) e a falha de serialização (40001) viram 409 `concurrent_update` ("tente de novo") no filtro de erros, em vez de 500.
- **Risco da ADR 0042 fechado:** mover para dentro de uma ideia trava as linhas da subárvore (inclusive o próprio ticket) e relê a situação do ticket e dos descendentes depois da trava; a mudança de situação relê o pai e a situação da linha travada.
- **Reprodução:** com duas conexões e ordem forçada, A para dentro de B e B para dentro de A respondiam 200 e 200 e gravavam o ciclo; agora respondem 200 e 409 `ticket_cycle`.
- **Guarda de cobertura:** `apps/api/test/structure-lock-coverage.test.ts` falha se um arquivo grava pai ou estágio de ideia, cria ou remove ticket sem chamar a trava. Sem comentários, por arquivo e, nos quatro arquivos principais, por método (cada método que grava estrutura trava ou chama um auxiliar do mesmo arquivo que trava); os limites estão no cabeçalho do teste. A ordem dentro do método é coberta pelos testes de corrida.
- **Gatilho no banco (migration `0023`):** `tickets_no_parent_cycle`, antes de `UPDATE` de `parent_id`, sobe de pai em pai e recusa ciclo; o custo é a profundidade (limite de 10 000 saltos). A mesma migration acrescenta o CHECK `parent_id <> id` (auto-pai, também no INSERT). Não cobre par mútuo ou ciclo inserido no mesmo comando com ids explícitos. Sozinho não pega a corrida (cada transação só vê dados confirmados); protege de quem escreve fora da trava. A API não traduz o erro do gatilho, porque a conferência e a trava vêm antes; se ele disparar, é defeito e aparece como erro do servidor.
- **Continua em aberto:** repetição automática no servidor e a medição com muitos agentes escrevendo no mesmo projeto.

## Adendo 1 (2026-11-23): quem espera a trava não segura conexão, e fila cheia vira "tente de novo"

Decisão da coordenação, reversível. Fonte: a medição de escrita concorrente ([docs/medicoes/2026-11-23-escrita-concorrente.md](../medicoes/2026-11-23-escrita-concorrente.md), `TREEPM-249`), que fecha o item 2 de "Em aberto".

**O que a medição mostrou.** A trava não deixou passar nenhum dado errado em 37 rodadas com até 64 escritores (nenhum ciclo, nenhum impasse). Dois problemas apareceram no caminho até ela:

1. A transação abre, ocupa uma das 10 conexões do pool e só então espera a trava. Com dezenas de mudanças de estrutura no mesmo projeto, 9 das 10 conexões ficam paradas esperando, e todo o resto da API (leituras e edições de outros projetos e de outras organizações) entra na fila do pool.
2. Quem fica mais de 2 s nessa fila (o padrão do Prisma, que o código não definia) recebe 500 "erro interno", porque a espera de 3 s pela trava nem chega a começar. Aconteceu com 64 escritores de estrutura em 20 000 tickets (`TREEPM-259`).

**Decisão.**

- **Fila em memória antes da transação (`TREEPM-260`).** Toda requisição que vai mudar a estrutura passa por uma fila do processo antes de abrir a transação. A chave é o projeto quando o chamador o conhece antes de abrir a transação, e a organização quando só conhece o ticket. No máximo **2** requisições por chave ficam com transação aberta ao mesmo tempo: uma com a trava e uma esperando por ela. As demais esperam na memória, sem conexão. Quem espera mais de 3 s na fila recebe 409 `structure_busy`, a mesma resposta de hoje.
- **A trava consultiva do banco continua sendo a regra.** A fila só limita quantas conexões um projeto ocupa; ela não substitui a trava, não é condição de correção e vale por instância da API. Com mais de uma instância, cada uma tem a sua fila e a trava do banco continua valendo entre elas.
- **Fila do pool cheia vira "tente de novo" (`TREEPM-259`).** A espera por conexão passa a ser definida no código (5 s). Estourou, em qualquer rota: 503 `server_busy` com `Retry-After: 1`, não 500. A tela e o MCP tratam como "tente de novo".
- **Tamanho do pool.** Fica em 10 nesta mudança. Com a fila, um projeto disputado ocupa 2 conexões em vez de 10; o tamanho só muda depois de medir com o banco remoto.

**Fora deste adendo.** A leitura do projeto inteiro dentro da trava (`TREEPM-261`), que limita o projeto a cerca de 50 mudanças de estrutura por segundo com 5 000 tickets e 18 com 20 000, e a repetição automática no servidor (item 1 de "Em aberto"), que continua em aberto.
