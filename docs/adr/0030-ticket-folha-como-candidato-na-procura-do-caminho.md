# ADR 0030 — Ticket folha como candidato na procura do caminho

**Status:** Aceita, com a regra de candidatos substituída pela [ADR 0031](0031-agrupadores.md). A reconstrução do `TREEPM` foi **cancelada** em 2026-11-21 (ver "Resultado da primeira medição"). **Data:** 2026-11-20.

## Contexto

A [ADR 0029](0029-novo-ticket-pela-conversa-com-a-ia.md) definiu que, em cada nível da procura, os candidatos são só os filhos que já têm filhos. Um ticket folha nunca é oferecido ao Jev.

Isso tem duas consequências que contrariam a intenção do produto:

- **Projeto vazio não se organiza.** Sem ramo nenhum, o primeiro ticket vai para a raiz; ele é folha, então o segundo também vai, e assim por diante. Um grupo recém-criado, ainda sem filhos, também nunca recebe nada.
- **A IA nunca aprofunda a árvore.** Ela distribui tickets entre grupos que alguém já montou, mas não põe um trabalho dentro de outro que ainda não foi decomposto. A profundidade só cresce à mão, pelo "Novo subticket".

Em 2026-11-20 Teodoro pediu a mudança ("definitivamente é a sua proposta o que eu quero pro projeto") e pediu que o projeto `TREEPM` seja zerado e reconstruído ticket por ticket com o Jev escolhendo o lugar.

## Decisão

### Todo filho é candidato

Substituído pela [ADR 0031](0031-agrupadores.md): os candidatos passam a ser só os agrupadores filhos, vazios ou não, e ticket nunca é candidato. O aviso da web descrito abaixo também deixa de existir.

Em cada nível, os candidatos passam a ser **todos os filhos diretos** do nó atual, com ou sem filhos. O resto da procura não muda: mesmas duas perguntas por nível, mesmos limiares (0,3 e 0,7), até 3 caminhos, mesma nota, mesmos limites.

- Quando a procura desce para uma folha, o nível seguinte não tem candidatos e ela para ali: o ticket novo vira o **primeiro subticket** dessa folha.
- Na raiz de um projeto vazio não há candidatos e o ticket vira ticket de raiz, como antes.

### O que representa cada candidato

- **Ticket com filhos:** título e o resumo do ramo, escrito pelo Claude, como na ADR 0029.
- **Ticket folha:** título e o trecho da descrição que a API já calcula (os primeiros 600 caracteres). **Folha não passa pelo resumidor**: não há chamada ao Claude para ela.
- Folha sem descrição é representada só pelo título.

### Texto enviado ao Jev

O estado passa a ter estes campos:

- `draft`: `title` e `description` do rascunho.
- `current_ticket`: `title` e `subtickets_summary` do nó atual. Ausente na raiz do projeto.
- `candidates`: lista. Ticket com filhos entra com `title` e `subtickets_summary`; folha entra com `title` e `description`, e sem o campo `description` quando a descrição é vazia.

As duas perguntas, com o texto exato:

**`Noul` (pertence a algum):**

- Pergunta: "O trabalho descrito em `draft` é uma parte do trabalho de pelo menos um dos tickets de `candidates`?"
- Verdadeiro: "`draft` descreve um pedaço do que um dos tickets de `candidates` abrange: a equipe esperaria encontrá-lo como subticket desse ticket."
- Falso: "`draft` não é um pedaço de nenhum dos tickets de `candidates`. Ele é mais geral que todos eles, trata de um assunto novo, ou é um trabalho vizinho de um deles: do mesmo tema, mas que se faz e se conclui de forma independente. Nesses casos ele ficaria ao lado dos tickets de `candidates`, e não dentro de um deles."

**`Choice` (qual):**

- Pergunta: "De qual dos tickets de `candidates` o trabalho descrito em `draft` é uma parte?"
- Opções: o nome de cada opção é o título do ticket (repetidos ganham " (2)", " (3)", como hoje). A descrição da opção é o resumo do ramo ou o trecho da descrição da folha; folha sem descrição fica com a opção sem descrição (`null`), que o SDK aceita.

O caso que mais confunde está nomeado no critério falso: trabalho do mesmo tema, mas independente, é vizinho e não parte.

### Na web

- Quando o destino mostrado é um ticket que ainda não tem subtickets, o painel avisa: "«título» ainda não tem subtickets. O ticket novo será o primeiro."
- O card tracejado aparece sozinho abaixo do ticket de destino. Nada mais muda no painel nem no mapa.

### Reconstrução do `TREEPM` como primeira medição

O projeto `TREEPM` (45 tickets, seis grupos e seus itens) é zerado e reinserido pela API real, um ticket por vez, na ordem: primeiro os seis grupos, depois os itens. A árvore de antes fica guardada como gabarito.

- **Texto dos tickets:** título e descrição entram exatamente como estavam. A conversa é aberta com o texto do ticket (o Claude responde, e a resposta fica registrada para análise), mas o rascunho é reposto com o texto original antes da procura.
- **Lugar:** a execução automática aceita sempre o `destination` da procura. Na faixa do meio (entre 0,3 e 0,7), "parar aqui" vem antes de "descer", então o caso em dúvida fica no lugar mais raso. Os casos marcados como incertos são contados à parte, com a alternativa que ficou de fora.
- **Comparação com o gabarito, em três grupos:** mesmo pai; mais fundo dentro do grupo certo; em outro lugar. O gabarito tem só dois níveis, então "mais fundo dentro do grupo certo" não é erro por si só.
- **Probabilidades:** a ferramenta registra, em arquivo local que não vai para o Git nem para log, o `Noul` e o `Choice` de cada nível de cada ticket. Sem isso não há como calibrar os limiares.
- **Depois:** situações e pessoas atribuídas são reaplicadas pelo que o gabarito guardava.
- **Segurança:** o gabarito é exportado do projeto vivo e conferido antes de qualquer remoção; a volta ao estado original, pela rota de importação, é provada no banco de teste antes; e os primeiros itens são ensaiados com os provedores reais em um projeto descartável.

A ferramenta fica em `apps/api/scripts`, como a de conferência dos provedores, e serve para repetir a medição quando o texto das perguntas ou os limiares mudarem. Ela sobe a API real com uma sessão fixa, só em processo local.

### Resultado da primeira medição (2026-11-20)

A reconstrução **não foi feita no `TREEPM`**, que continua como estava. Os 45 tickets do gabarito foram inseridos, na ordem e com as regras acima, em um projeto descartável (`ENSAIO`, na mesma organização), com Claude e Jev reais. Uma rodada só, em uma ordem só.

| Onde ficou, na árvore reconstruída | Tickets |
| --- | ---: |
| Mesmo pai do gabarito | 9 (os 6 grupos, na raiz, e 3 itens) |
| Mais fundo dentro do grupo certo | 4 |
| Em outro lugar | 32 (24 deles na raiz) |

- 27 dos 45 resultados vieram marcados como incertos. Entre os 39 itens, o lugar do gabarito estava no destino ou nas alternativas oferecidas em 13.
- Na raiz, o `Noul` dos 39 itens (que deveriam descer) ficou abaixo de 0,3 em 7, entre 0,3 e 0,7 em 17 e acima de 0,7 em 15. Nenhum dos 5 grupos julgados (que deveriam ficar na raiz) passou de 0,7.
- Quando o `Noul` passou de 0,7, o `Choice` apontou o grupo certo em 7 de 15. Os erros foram escolhas de um item solto na raiz em vez do grupo.
- O `Choice` acertou o grupo em 4 de 5 julgamentos com até 10 candidatos e em 14 de 34 com mais de 10.
- Tempo: 6 min e 21 s no total; mediana de 8,4 s por ticket, dos quais 6,6 s são o turno do Claude e 0,6 s a procura.

O que os números mostram:

- **A inserção um por um em projeto vazio reforça os próprios erros.** O item que cai na faixa do meio fica na raiz; a raiz cresce (chegou a 30 candidatos); os itens seguintes passam a ser comparados com itens soltos, e alguns entram dentro deles em cadeia.
- **Grupo recém-criado tem pouco texto.** Quatro dos seis grupos não têm descrição, e sem filhos não há resumo.
- **O gabarito não é neutro:** o agrupamento original veio de conhecimento do projeto que não está no texto dos tickets.

O que **não** se conclui daqui: nada sobre os limiares, o texto das perguntas ou a regra da faixa do meio. É uma rodada, cada colocação depende das anteriores, e os mesmos 45 itens seriam ao mesmo tempo ajuste e prova.

O que esta rodada não mediu é o uso para o qual a procura foi desenhada: pôr **um** ticket em uma árvore já organizada. A medição seguinte tira um ticket por vez de uma cópia da árvore original, pede o lugar e o devolve. Organizar uma lista inteira de uma vez é outra funcionalidade (IDEA-010) e pede outra técnica.

**Decisão de 2026-11-21:** Teodoro aceitou a recomendação da coordenação de **não reconstruir** o `TREEPM`. Do zero, 9 de 45 voltaram ao lugar; com a árvore organizada e os agrupadores da ADR 0031, 23 de 39 voltam sozinhos e outros 10 ficam entre as opções oferecidas. Os seis grupos do `TREEPM` já são agrupadores desde a migration 0006. Os seis projetos de medição (`ENSAIO`, `BASE`, `DEPOIS`, `ESCOPO`, `PLANO` e `GRUPOS`) foram arquivados no mesmo dia; os arquivos das rodadas continuam fora do Git, com a coordenação.

A ferramenta classificou 8 tickets como "mais fundo" por olhar a ascendência no gabarito, e não na árvore reconstruída; os números acima já estão corrigidos; a correção da ferramenta vem em seguida.

## Fora desta ADR

- **Criar categoria intermediária.** A IDEA-005 prevê que a IA proponha um grupo novo quando nenhum serve. Continua fora.
- **Mudar os limiares ou separar as perguntas por tipo de candidato.** Decide-se com o resultado da medição, não antes.
- **Reclassificação ao editar (IDEA-014).** Continua esperando essa mesma medição.

## Consequências

- A IA passa a organizar um projeto vazio e a aprofundar a árvore.
- Um ticket folha que ganha o primeiro subticket deixa de mostrar a própria situação e passa a mostrar o progresso dos filhos. A situação que ele tinha continua guardada, como a ADR 0024 já define. Isso vale também quando a folha estava concluída: a IA pode propor um trabalho novo dentro de um ticket concluído, e a pessoa decide.
- Cada nível manda mais candidatos ao Jev. Um nó com muitos filhos diretos e com descrição (na ordem de uma centena) passa do teto de tokens, e a procura para ali e avisa, como a ADR 0029 já prevê. Encurtar o texto das folhas nesse caso fica como evolução.
- Um ticket parecido com outro pode ser proposto como parte dele em vez de vizinho. É o erro que a medição precisa quantificar.
- A reconstrução troca as chaves dos tickets do `TREEPM` (os números não são reaproveitados) e apaga o histórico de eventos dos tickets removidos.
- Reinserir os mesmos 45 itens tende a dar de novo uma árvore de quase dois níveis: os itens foram escritos como vizinhos, não como partes uns dos outros.
