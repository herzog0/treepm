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
- **Espera limitada:** 5 s (`lock_timeout` só durante a espera pela trava). Estourou: 409 `structure_busy`, com frase própria na web nos três idiomas.
- **Risco da ADR 0042 fechado:** mover para dentro de uma ideia trava as linhas da subárvore antes de ler as situações.
- **Reprodução:** com duas conexões e ordem forçada, A para dentro de B e B para dentro de A respondiam 200 e 200 e gravavam o ciclo; agora respondem 200 e 409 `ticket_cycle`.
- **Guarda de cobertura:** `apps/api/test/structure-lock-coverage.test.ts` falha se um arquivo grava pai ou estágio de ideia, cria ou remove ticket sem chamar a trava. A conferência é por arquivo, não por função; a ordem dentro do arquivo é coberta pelos testes de corrida.
- **Gatilho no banco (migration `0023`):** `tickets_no_parent_cycle`, antes de `UPDATE` de `parent_id`, sobe de pai em pai e recusa ciclo; o custo é a profundidade. Sozinho não pega a corrida (cada transação só vê dados confirmados); protege de quem escreve fora da trava. A API não traduz o erro do gatilho, porque a conferência e a trava vêm antes; se ele disparar, é defeito e aparece como erro do servidor.
- **Continua em aberto:** repetição automática no servidor e a medição com muitos agentes escrevendo no mesmo projeto.
