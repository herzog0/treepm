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
- a hidratação do ticket por área fica com a Fase 2 e não é pré-requisito;
- a IA também forma agrupadores: quando o ticket novo tem afinidade com tickets soltos do nível em que ficou, ela **propõe** um agrupador para eles, e a pessoa confirma ("propõe e a pessoa confirma").

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

### Medição de antes (2026-11-20)

Rodada "tira um, recoloca" com a regra da ADR 0030 (todo filho é candidato), em uma cópia da árvore original do `TREEPM` (projeto `BASE`), com Claude e Jev reais: cada um dos 39 tickets foi removido, a procura foi pedida para o texto dele e ele foi devolvido ao lugar. Uma rodada só.

| Onde a procura pôs o ticket | Tickets |
| --- | ---: |
| No agrupador original | 10 |
| Dentro do agrupador original, mas como filho de outro ticket | 11 |
| Em outro lugar | 18 (15 deles na raiz) |

- 27 dos 39 resultados vieram incertos.
- **Na raiz**, onde os candidatos são os seis grupos: o `Choice` apontou o grupo original em 31 de 39. O `Noul` ficou acima de 0,7 em 24, entre 0,3 e 0,7 em 14 e abaixo de 0,3 em 1.
- **Dentro do grupo certo**, onde a procura deveria parar (33 julgamentos): o `Noul` passou de 0,7 em 13 e ficou na faixa do meio em 17. É o caso que esta ADR elimina, porque ticket deixa de ser candidato.
- Tempo: 6 min e 39 s; a procura levou 3,4 s de mediana por ticket, quase tudo em resumos refeitos pelo Claude depois de cada remoção.

Para a comparação de depois só serve a decisão na raiz, em que os candidatos são os mesmos seis agrupadores nas duas regras. Juntando as duas respostas na raiz: grupo certo com `Noul` acima de 0,7 em 21 tickets; grupo certo na faixa do meio em 9; grupo errado com `Noul` acima de 0,7 em 3; grupo errado na faixa do meio em 5; abaixo de 0,3 em 1. Com só agrupadores como candidatos e as mesmas respostas, isso daria 21 de 39 no lugar original sem intervenção, e mais 9 com o lugar original oferecido como alternativa. É uma conta, não uma medição: o texto das perguntas muda, e só a rodada de depois diz o efeito.

O agrupamento original continua sendo uma referência imperfeita: ele foi montado com conhecimento do projeto que não está no texto dos tickets.

### Escopo pela seleção

- Quando a pessoa abre o painel de novo ticket com um **agrupador selecionado**, a procura começa nele em vez da raiz do projeto. O painel mostra o escopo e oferece "Procurar no projeto inteiro".
- Sem seleção, ou com ticket ou projeto selecionado, a procura começa na raiz do projeto *(escolha da coordenação: só agrupador define escopo)*.
- A rota da procura aceita o agrupador de escopo. Ele precisa ser do mesmo projeto da conversa.
- **Aviso de escopo errado:** na primeira requisição ao Jev dentro de um escopo vai uma pergunta a mais, um `Noul`: "O trabalho descrito em `draft` cabe dentro do assunto do agrupador `scope`?". Abaixo de 0,3, o resultado vem marcado como fora do escopo e o painel avisa, com a ação de procurar no projeto inteiro. A procura não sobe sozinha.

### A IA propõe um agrupador novo

Decisão de Teodoro em 2026-11-20: a IA também forma agrupadores, inclusive dentro do agrupador selecionado, e quem confirma é a pessoa.

**Quando.** A procura termina em um destino: a raiz do projeto ou um agrupador. Se nesse destino há **tickets soltos** (filhos diretos do tipo `ticket`), a IA verifica se o ticket novo forma um grupo com algum deles. Vale igual para o destino dentro de um escopo.

**Quem faz o quê.**

1. **Jev julga a afinidade.** Uma requisição, com uma pergunta `Noul` por ticket solto. O estado traz o rascunho e o nó de destino; cada pergunta traz o título e o trecho da descrição do ticket a que se refere. O Jev não limita o número de perguntas por requisição; o limite é o de tokens (64 mil por requisição). Se os tickets soltos não couberem, a verificação não é feita e o resultado diz isso.
2. **O código decide.** Os tickets com `Noul` acima de 0,7 formam o grupo proposto. Basta um ticket existente além do novo. Sem nenhum, não há proposta.
3. **Claude escreve o nome e a descrição do agrupador**, a partir do rascunho e dos tickets do grupo. É uma chamada curta (Opus 5.5, esforço `low`, saída estruturada), como a do resumo de ramo, e só acontece quando há grupo. O texto enviado é o mesmo tipo de dado que a ADR 0029 já autoriza: texto de tickets do projeto e do rascunho.

**Texto da pergunta (provisório).**

- Pergunta: "O trabalho descrito em `draft` e o ticket descrito nesta pergunta fazem parte de um mesmo assunto, mais específico que o de `destination`, a ponto de a equipe guardá-los juntos em um agrupador próprio?"
- Verdadeiro: "Os dois são partes de uma mesma entrega ou de um mesmo assunto específico: faria sentido um agrupador só para eles e para outros parecidos."
- Falso: "Os dois tratam de assuntos diferentes, ou só têm em comum o assunto geral de `destination`, que já os contém."

O critério falso nomeia o caso que mais confunde: dois tickets que só têm em comum o agrupador em que já estão não formam um agrupador novo.

**O que a pessoa vê e faz.** O resultado da procura passa a trazer, quando houver, a proposta: nome, descrição e os tickets do grupo. O painel mostra a proposta com os tickets listados, e a pessoa pode tirar algum da lista. Duas ações: "Criar agrupador e mover" e "Só criar o ticket". Se a pessoa trocar o destino (alternativa, um nível acima ou escolha no mapa), a proposta é descartada.

**Ao confirmar.** Em uma só transação: cria o agrupador no destino, move para ele os tickets escolhidos e cria o ticket novo dentro dele. Antes, confere de novo que cada ticket escolhido ainda é um ticket solto daquele destino; se algum mudou, 409 `grouping_changed` e nada é criado. Grava os eventos de sempre (criação do agrupador, mudança de pai de cada ticket movido, criação do ticket), com a origem `assistant`.

**Limites.** A IA não propõe agrupador com tickets de níveis diferentes, não move agrupadores e não reorganiza o que já está agrupado. O limiar de 0,7 e o tamanho mínimo do grupo são iniciais e se ajustam por medição: desfazer um agrupador de uma cópia da árvore, deixar os tickets soltos e ver se a IA propõe o grupo de volta.

### Ferramenta de medição

A ferramenta de `apps/api/scripts` passa a guardar e a restaurar o tipo de cada nó.

### Ordem de entrega

1. Banco, domínio e API, com a procura nova. Um PR, que espera a migration 0006 no Neon.
2. Web: tipos no mapa, na página, na criação e no painel da IA.
3. Escopo pela seleção, API e web.
4. Proposta de agrupador pela IA, API e web.

## Fora desta ADR

- **Hidratação do ticket por área** (back-end, front-end e outras): entra com as contribuições por área da Fase 2.
- **Ligação com repositórios de código** (GitHub e outros): ADR própria.
- **Organizar uma lista inteira de uma vez** (IDEA-010): um pedido para a IA olhar todos os tickets soltos de um projeto ou agrupador e propor a organização.
- **Reclassificação ao editar** (IDEA-014).
- **Reconstrução do `TREEPM`**, que continua suspensa.

## Consequências

- A IA coloca tickets e **propõe** agrupadores. A profundidade nasce de três jeitos: a pessoa cria um agrupador, a pessoa transforma um ticket em agrupador, ou a pessoa aceita um agrupador proposto pela IA. A IA não aprofunda a árvore sem confirmação, e nunca põe ticket dentro de ticket, que foi o que a ADR 0030 permitiu por um dia.
- O primeiro motivo da ADR 0030 fica resolvido de outro jeito: um agrupador vazio é candidato, então um projeto novo com agrupadores se organiza.
- Um projeto sem nenhum agrupador recebe todo ticket novo na raiz.
- "Fechamento da Fase 1" deixa de ser um ticket ambíguo e passa a ser um agrupador, com a descrição dizendo o que ele engloba.
- A procura na raiz compara só agrupadores, e não mais dezenas de itens soltos.
- Quem seleciona o agrupador errado recebe um aviso, mas a decisão continua sendo da pessoa.
- Mais um conceito na interface: a pessoa precisa escolher entre criar ticket e criar agrupador.
- Aceitar um agrupador proposto move tickets que podem ser de outras pessoas. Por isso a proposta nunca se aplica sozinha.
- A proposta custa uma requisição ao Jev por ticket criado em nível com tickets soltos, e uma chamada curta ao Claude quando há grupo. O custo ainda não foi medido.
- A lista de importação não expressa agrupador vazio.
