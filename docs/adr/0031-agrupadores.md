# ADR 0031 — Agrupadores: tipo declarado, só agrupador tem filhos, e a procura desce por agrupadores

**Status:** Aceita. O texto das perguntas ao Jev é provisório até a medição de antes e depois. **Data:** 2026-11-20.

## Contexto

Desde a [ADR 0024](0024-tickets-primeiro-recorte-e-importacao-por-lista.md), o sistema deduz quem é grupo: é grupo o ticket que tem filhos. A primeira medição da procura do caminho ([ADR 0030](0030-ticket-folha-como-candidato-na-procura-do-caminho.md)) mostrou dois problemas que vêm dessa dedução:

- um grupo vazio é indistinguível de um ticket comum, e por isso a ADR 0030 tornou toda folha candidata;
- com toda folha candidata, tickets comuns viraram pais uns dos outros em cadeia.

Em 2026-11-20 Teodoro propôs separar **tickets** de **agrupadores** ("o card pai não é um ticket exatamente, é um agrupador"; um agrupador engloba uma subárvore que representa um mini produto, como "Entrega da Fase 1") e buscar o lugar de um ticket novo só na subárvore do agrupador selecionado. Ele aprovou a proposta da coordenação com estes pontos:

- só agrupador tem filhos, e agrupadores ficam dentro de agrupadores sem limite de profundidade;
- criar ticket sem agrupador selecionado continua permitido, com a procura a partir da raiz do projeto;
- a seleção de um agrupador define o escopo da procura;
- a hidratação do ticket por área fica com a Fase 2 e não é pré-requisito.

Os demais pontos desta ADR são escolhas da coordenação e estão marcados como tal.

## Decisão

### Dois tipos na mesma árvore

Cada nó da árvore de um projeto tem um **tipo** declarado: `ticket` ou `group`. Na interface, "ticket" e "agrupador".

- Os dois ficam na mesma tabela, usam a mesma sequência de números e chaves (`TREEPM-12`), as mesmas rotas e as mesmas permissões.
- **Só agrupador tem filhos.** O pai de qualquer nó é um agrupador do mesmo projeto, ou nenhum (raiz do projeto). A raiz aceita tickets e agrupadores.
- **O banco garante a regra** *(escolha da coordenação)*: o tipo do pai faz parte da chave estrangeira do pai, como o projeto já faz. Assim, transformar em ticket um agrupador que tem filhos falha no banco, mesmo em requisições simultâneas. Se o Prisma não conseguir expressar isso, vale um gatilho de restrição com o mesmo efeito, e a implementação diz qual usou.
- **Agrupador:** título, descrição e pessoas atribuídas, como hoje tem um ticket com filhos. Não tem situação: a API devolve `status: null` e recusa mudar a situação com 409 `group_has_no_status`. Traz sempre `progress`, calculado sobre os tickets descendentes; vazio, o progresso é zero de zero.
- **Ticket:** como hoje a folha. Tem situação, `progress: null`, e nunca tem filhos.
- Criar ou mover um nó para dentro de um ticket: 409 `parent_not_group`.

### Transformar um no outro *(escolha da coordenação)*

- **Ticket em agrupador:** sempre permitido a quem pode editar. A situação guardada é preservada no banco, como a ADR 0024 já faz quando uma folha ganha filhos. É assim que se decompõe um ticket.
- **Agrupador em ticket:** só quando está vazio; com filhos, 409 `ticket_has_children`. A situação guardada volta a valer.
- É um `PATCH` com `kind`, e grava `ticket.updated` com o campo alterado.

### Dados existentes (migration 0006)

Todo ticket que tem pelo menos um filho passa a ser agrupador; os demais ficam como tickets. Isso vale para todos os projetos, inclusive os de ensaio. Nada é movido nem removido.

A migration tem que estar no Neon de desenvolvimento antes de a API correspondente entrar no `main`.

### Criação

- A rota de criação aceita `kind`, com `ticket` como padrão.
- Na página de um agrupador e no detalhe do projeto: "Novo ticket" e "Novo agrupador".
- Na página de um ticket não há mais "Novo subticket"; há "Transformar em agrupador".
- **Importação por lista:** item com filhos vira agrupador, item sem filhos vira ticket. A lista não tem como declarar um agrupador vazio; ele é criado pela interface. A rota de importação aceita `kind` por item, e recusa item com filhos declarado como ticket.

### No mapa e na página

- **Card do agrupador:** o card que o ticket com filhos já tem hoje (marcador de progresso, "n de m concluídos", cor pela mistura das situações dos descendentes).
- **Agrupador vazio** *(escolha da coordenação)*: marcador vazio, texto "vazio" no lugar do progresso e a cor neutra de "a fazer".
- **Página do agrupador:** sem a seção de situação; com progresso, pessoas, descrição e a lista de itens, que mostra o tipo de cada um.
- **Mudar o pai:** a escolha lista só agrupadores e a raiz do projeto.
- **"Escolher no mapa", no painel da IA** *(escolha da coordenação)*: clicar em um agrupador ou no projeto escolhe esse destino. Clicar em um ticket escolhe o agrupador que o contém (ou a raiz), e o painel diz isso.
- Gestos, câmera, limiares de zoom e o resto da interação aprovada não mudam.

### A procura do caminho

Substitui a regra de candidatos da ADR 0030.

- Em cada nível, os candidatos são os **agrupadores filhos** do nó atual, vazios ou não. Ticket nunca é candidato.
- Agrupador com filhos entra com título e o resumo escrito pelo Claude. Agrupador vazio entra com título e o trecho da descrição, sem chamada ao Claude.
- O ticket novo é sempre do tipo `ticket` e entra como filho do agrupador mais fundo que servir, ou na raiz do projeto quando nenhum serve.
- Limiares, número de caminhos, nota, limites e a regra da faixa do meio continuam os da ADR 0029.
- O aviso "ainda não tem subtickets" da ADR 0030 deixa de existir.

**Texto enviado ao Jev (provisório).** Estado: `draft` (`title`, `description`); `current_group` (`title`, `summary`), ausente na raiz ou no escopo sem resumo; `candidate_groups`, cada um com `title` e `summary` (com filhos) ou `title` e `description` (vazio; sem o campo quando não há descrição).

- `Noul`: "O trabalho descrito em `draft` cabe dentro do assunto de pelo menos um dos agrupadores de `candidate_groups`?"
  - Verdadeiro: "O trabalho de `draft` trata de um assunto que um dos agrupadores de `candidate_groups` cobre, como um item que a equipe esperaria encontrar dentro dele."
  - Falso: "O trabalho de `draft` trata de um assunto que nenhum dos agrupadores de `candidate_groups` cobre: é mais geral que todos eles ou é um assunto novo, e seria encontrado direto no nível em que estamos."
- `Choice`: "Qual dos agrupadores de `candidate_groups` cobre o trabalho descrito em `draft`?" Opções pelo título, com o resumo ou o trecho da descrição; agrupador vazio e sem descrição fica com a opção sem descrição.

É o texto da ADR 0029 com "agrupador" no lugar de "ramo". Ele só se confirma depois de uma medição do tipo "tira um, recoloca" antes e depois da mudança, na mesma árvore. Os julgamentos do segundo nível da medição de antes não servem de comparação, porque medem candidatos que esta ADR elimina.

### Escopo pela seleção

- Quando a pessoa abre o painel de novo ticket com um **agrupador selecionado**, a procura começa nele em vez da raiz do projeto. O painel mostra o escopo e oferece "Procurar no projeto inteiro".
- Sem seleção, ou com ticket ou projeto selecionado, a procura começa na raiz do projeto *(escolha da coordenação: só agrupador define escopo)*.
- A rota da procura aceita o agrupador de escopo. Ele precisa ser do mesmo projeto da conversa.
- **Aviso de escopo errado:** na primeira requisição ao Jev dentro de um escopo vai uma pergunta a mais, um `Noul`: "O trabalho descrito em `draft` cabe dentro do assunto do agrupador `scope`?". Abaixo de 0,3, o resultado vem marcado como fora do escopo e o painel avisa, com a ação de procurar no projeto inteiro. A procura não sobe sozinha.

### Ferramenta de medição

A ferramenta de `apps/api/scripts` passa a guardar e a restaurar o tipo de cada nó.

### Ordem de entrega

1. Banco, domínio e API, com a procura nova. Um PR, que espera a migration 0006 no Neon.
2. Web: tipos no mapa, na página, na criação e no painel da IA.
3. Escopo pela seleção, API e web.

## Fora desta ADR

- **Hidratação do ticket por área** (back-end, front-end e outras): entra com as contribuições por área da Fase 2.
- **Ligação com repositórios de código** (GitHub e outros): ADR própria.
- **Organizar uma lista inteira de uma vez** (IDEA-010) e **criar agrupador pela IA** quando nenhum serve (IDEA-005).
- **Reclassificação ao editar** (IDEA-014).
- **Reconstrução do `TREEPM`**, que continua suspensa.

## Consequências

- A IA volta a só **colocar** tickets. Quem cria profundidade são as pessoas, criando agrupadores ou transformando um ticket em agrupador. Isso desfaz o segundo motivo da ADR 0030, que durou um dia: a IA não aprofunda mais a árvore sozinha.
- O primeiro motivo da ADR 0030 fica resolvido de outro jeito: um agrupador vazio é candidato, então um projeto novo com agrupadores se organiza.
- Um projeto sem nenhum agrupador recebe todo ticket novo na raiz.
- "Fechamento da Fase 1" deixa de ser um ticket ambíguo e passa a ser um agrupador, com a descrição dizendo o que ele engloba.
- A procura na raiz compara só agrupadores, e não mais dezenas de itens soltos.
- Quem seleciona o agrupador errado recebe um aviso, mas a decisão continua sendo da pessoa.
- Mais um conceito na interface: a pessoa precisa escolher entre criar ticket e criar agrupador.
- A lista de importação não expressa agrupador vazio.
