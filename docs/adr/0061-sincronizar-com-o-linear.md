# 0061 — Sincronizar com o Linear: o botão, os atributos que chegam depois e o que o TreePM já sabe guardar

- **Data:** 2026-11-25
- **Situação:** pedido de Teodoro em 2026-11-25 (`TREEPM-462`, `TREEPM-489`). Ele respondeu, item a item, quais atributos do Linear entram, quais ficam para depois e quais são ignorados; o resultado está no `TREEPM-462`. O desenho abaixo é da coordenação, por delegação. Completa a [ADR 0060](0060-importar-do-linear.md).

## Contexto

A importação da ADR 0060 traz o mínimo para a árvore existir: título, descrição, tipo da situação, prioridade, responsável, pai e projeto. Depois de importar o próprio time, Teodoro pediu o resto: "mapeie os atributos que puxamos pra que a gente possa implementá-los na nossa aplicação também", e depois "implementa também um botão de sincronização, pra puxar esses atributos do linear e colocar eles nos cards corretos quando tudo isso estiver implementado".

São 21 atributos aprovados. Eles não cabem numa decisão só, porque são de três naturezas:

1. **O TreePM já tem o conceito** e falta a importação preencher: comentários, relações, criador e data, identificadores antigos, datas de início e de conclusão, histórico, e do projeto do Linear a descrição, o líder e a prioridade (`TREEPM-464`).
2. **Atributo novo no produto:** etiquetas, prazo, estimativa, ciclo, marco, anexos, ordem manual, nome de branch, quem acompanha, documentos (`TREEPM-463`). Cada um muda banco, API e tela, e ganha a própria fatia; os que criam conceito (ciclo, ordem manual) ganham ADR.
3. **Situações novas** (`TREEPM-472`): mexem na regra de cor do mapa ([ADR 0051](0051-cores-por-situacao-e-propagacao-do-mais-preocupante.md)), que Teodoro aprovou olhando o desenho. Ganham ADR própria e passam pelo Claude Design.

Esta ADR decide o que os três grupos têm em comum (a mecânica de sincronizar) e o grupo 1.

Fatos conferidos no esquema do Linear em 2026-11-25: a consulta de raiz `comments` aceita filtro pela issue, e o filtro de issue aceita o time; `issueRelations` na raiz não aceita filtro, então relações vêm aninhadas na issue; `history` só existe por issue. Cada consulta tem teto de 10.000 pontos de complexidade, e uma conexão aninhada multiplica o custo pelo tamanho da página.

## Decisão

### 1. Sincronizar é a reimportação, com outro nome e outro lugar

- Não há mecanismo novo. "Sincronizar com o Linear" abre uma rodada `reimport` da ADR 0060: percorre o time inteiro, em passos que o navegador conduz, sem duplicar.
- O botão fica no projeto ligado a um time, fora da tela de importar: no menu do projeto e no cartão "Linear" das Configurações do projeto. Mostra quando foi a última sincronização. Quem pode usar é quem pode importar, com a própria chave.
- A tela de andamento e o resumo são os que já existem. O resumo ganha uma linha por tipo de coisa trazida (comentários, relações).
- Continua puxado pela pessoa. Sincronização contínua é a `TREEPM-319`.

### 2. Atributo que chega depois: a regra do campo sem retrato

A reimportação compara cada campo com o retrato da última importação. Um atributo novo não tem retrato nos tickets já importados. Regra, por campo:

- **Sem retrato e vazio no TreePM:** preenche com o valor do Linear e grava os dois lados do retrato. É o caso comum, e é o que faz o botão "colocar nos cards corretos".
- **Sem retrato e já preenchido no TreePM** (alguém pôs um valor aqui antes de o atributo ser sincronizado): o valor do TreePM fica. O retrato grava o lado do Linear e marca o campo como "mantido daqui", e ele não volta a ser sobrescrito sozinho.
- **Com retrato:** a regra da ADR 0060 (só muda o que mudou lá e não foi mexido aqui).

"Vazio" é definido por atributo na fatia dele (texto vazio, lista vazia, nulo). Nas issues, prioridade e situação já têm retrato desde a primeira importação e seguem a regra antiga. No ticket de projeto, que nasceu sem esses campos, prioridade 0 conta como vazio enquanto não houver retrato.

Sem retrato não há como distinguir "nunca teve" de "limparam de propósito": um ticket de projeto que alguém preencheu e depois esvaziou antes da primeira sincronização é preenchido de novo, uma vez. Depois disso o retrato existe e a limpeza é respeitada.

### 3. Coisas que são muitas por ticket têm origem própria

Comentários e relações (e, nas fatias deles, etiquetas, anexos e documentos) não cabem no retrato do ticket. Cada item guarda a própria origem: provedor, tipo, id estável do Linear e o que foi aplicado, com a mesma unicidade por organização da origem de ticket.

- **Novo no Linear:** é criado aqui.
- **Editado no Linear:** atualiza aqui se o item não foi editado no TreePM.
- **Sumiu do Linear:** fica como está, com a marca de "não encontrado desde". Nada é apagado sozinho, como na ADR 0060.
- **Apagado no TreePM:** não volta. A origem guarda que foi removido aqui.

### 4. O que cada atributo do grupo 1 vira

| No Linear | No TreePM |
| --- | --- |
| Comentários da issue | Comentários do ticket, na ordem e com a data originais. Respostas (comentário com pai) entram em sequência, sem aninhamento, com a citação do pai quando houver. |
| Relação "blocks" | "Depende de", no sentido inverso (se A bloqueia B, B depende de A). Só quando as duas issues foram importadas. |
| Relações "related" e "duplicate" | Tipo novo de relação "relacionado", sem regra nenhuma além de aparecer na página dos dois tickets. "Duplicate" entra como relacionado. |
| Criador e data de criação | Guardados na origem e mostrados na página do ticket ("Criado no Linear em 3 de março, por Ana"). `createdAt` e o criador do ticket não são reescritos: várias ordenações e a linha do tempo dependem deles. |
| Datas de início, conclusão e cancelamento | Guardadas na origem e mostradas junto da criação. |
| Identificadores antigos | Guardados na origem. A busca por chave encontra o ticket por qualquer um deles (liga com a `TREEPM-441`). |
| Projeto do Linear: descrição | Descrição do ticket pai (o conteúdo longo quando existe; senão o resumo). |
| Projeto do Linear: líder | Responsável do ticket pai, pela mesma regra de e-mail único. |
| Projeto do Linear: prioridade | Prioridade do ticket pai, pela tabela da ADR 0060. |
| Histórico da issue | Fatia própria, a última (seção 7). |

As datas do projeto dependem do prazo e entram na fatia dele.

### 5. Autoria de quem não está no TreePM

Comentário e evento têm autor. No Linear o autor pode não ter conta aqui, ou o e-mail pode não casar.

- Casa por e-mail único, como o responsável: o autor é a pessoa do TreePM.
- Não casa: o comentário fica **sem autor do TreePM**, com o nome de exibição do usuário do Linear guardado na origem do comentário e mostrado como "Ana (no Linear)". Nunca é atribuído a quem sincronizou.
- O e-mail continua não sendo guardado. O nome de exibição é dado pessoal novo no banco: a linha do Linear na Política de privacidade muda na mesma mudança.

### 6. Texto que vem de fora, IA e MCP

- O corpo de comentário importado passa pela mesma neutralização da descrição (ADR 0060, seção 4): nada vira menção de pessoa, e os limites de tamanho do TreePM valem.
- **O que é dado da origem não vai a provedor de IA, à Voyage nem ao MCP:** nome de criador ou de autor do Linear, datas, identificadores antigos. Comentários já ficam fora.
- **Uma exceção, que não é categoria nova:** a descrição do projeto do Linear vira a descrição do ticket pai e, como toda descrição de ticket, vai aos provedores quando o assistente está ativo, neutralizada e cortada como as demais. Cada fatia futura declara o mesmo ponto para o atributo dela, e o padrão é fora.
- Conteúdo de documentos do Linear (`TREEPM-476`) é categoria nova de dado: antes de qualquer envio a provedor, Teodoro é avisado.

### 7. Custo no Linear e fases da rodada

- A rodada ganha as fases `comments` (consulta de raiz filtrada pelo time, uma página por passo) e `relations`. Os campos simples da issue e do projeto entram nas consultas que já existem.
- Antes de aninhar qualquer conexão, a fatia calcula os pontos da consulta pela regra documentada do Linear e fica abaixo de metade do teto; o cálculo vai no relatório.
- O histórico é uma chamada por issue. Fica por último, depois de medir quantas requisições um time real consome, e só então se decide a forma (tudo, só mudanças de situação, ou só as issues abertas).

## Fatias

1. **Sincronizar e campos simples:** o botão, a regra do campo sem retrato, criador e datas, identificadores antigos, descrição, líder e prioridade do projeto (`TREEPM-489`, `479`, `480`, `481`, `483`, `484`, `485`).
2. **Comentários** (`TREEPM-477`), com a origem por item e a autoria.
3. **Relações** (`TREEPM-478`), com o tipo "relacionado".
4. **Histórico** (`TREEPM-482`), depois da medição.

Depois, fora desta ADR: situações novas (ADR própria e desenho), etiquetas e prazo, e os demais atributos do `TREEPM-463`.

## Fora deste recorte

- Arquivadas, SLA e afins, saúde do projeto e decoração do projeto: ignorados por Teodoro.
- Iniciativas e a lista de marcos do projeto: para depois (`TREEPM-465`).
- Escrever no Linear, sincronização contínua e webhooks.

## Em aberto

- Se o e-mail dos usuários do Linear é legível com a chave de Teodoro (`TREEPM-426`): criador, líder e autores dependem disso. Sem e-mail, todos caem em "no Linear".
- O lugar exato do botão no menu do projeto é texto e posição, sem tela nova; se pedir mais que isso, passa pelo Claude Design.

## Consequências

- Um ticket importado passa a carregar texto de outras pessoas que nunca entraram no TreePM (comentários), com o nome delas.
- A reimportação fica mais longa: uma fase a mais por tipo de item.
- A regra do campo sem retrato vale para todo atributo futuro; nenhuma fatia nova precisa redecidir o que fazer com tickets já importados.

## Como ficou (fatia 1, 2026-11-25)

- Migration `0043_linear_sync_fields`: a origem do ticket guarda as datas de criação, início, conclusão e cancelamento, os identificadores antigos e o criador (pessoa do TreePM quando o e-mail casa; senão o nome de exibição no Linear).
- O ticket de projeto ganha descrição, líder e prioridade. A regra do campo sem retrato está em `decideLinearLateField`; "mantido daqui" é a lista `heldHere` no retrato aplicado.
- O resumo da rodada ganhou "campos preenchidos em tickets que já existiam".
- Botão "Sincronizar com o Linear" em Configurações → Linear (na linha do time ligado, com a última sincronização) e no painel do projeto, ao lado de "Importar lista". Os dois abrem a tela de andamento que já existia, já iniciando a rodada. Onde a tela dizia "Reimportar", diz "Sincronizar".
- A página do ticket mostra "Criado no Linear em…, por…" e as datas, em texto secundário.
- A busca da barra acha o ticket pela chave do Linear, a atual e as antigas. As chaves vão só na lista de tickets que a tela carrega (cerca de 7 KB comprimidos a mais a cada 2.000 tickets importados); assistente, Voyage e MCP não as recebem.
- Página de projetos grande demais é reduzida à metade até 1; só então o texto longo daquele projeto é dispensado e o resumo entra no lugar, se o ticket ainda não tinha descrição.
- Consequência a saber: issues sem prioridade herdam a prioridade do ticket do projeto, e sobem ou descem na fila de trabalho com ela.
- Revisão independente com reprodução: sem bloqueio; cinco correções aplicadas.

## Como ficou (fatia 2, comentários, 2026-11-25)

- Migration `0044_linear_comments`: tabela `external_item_refs` (origem por item, hoje só comentários), `ticket_comments` com autor opcional, `external_author_name` e `via = 'linear'`. A migration zera os nomes de criador já gravados em forma de e-mail; é a única linha que altera dado.
- Fase nova `comments` na rodada, pela consulta de raiz filtrada pelo time, 50 por página (367 pontos de complexidade). Cabe no orçamento de chamadas e de tempo do passo, também quando conduzida pelo MCP.
- O comentário entra com a data original e o selo "do Linear". Resposta entra em sequência, com uma linha de citação do pai. Não pode ser editado aqui; removido aqui, não volta, e a citação dele sai das respostas.
- **O autor acompanha o casamento atual**, nos dois sentidos: a cada sincronização com e-mail legível, é a pessoa do TreePM que casa ou, se nenhuma casa, o nome no Linear. Em rodada sem e-mail legível o autor não muda. Comentário escrito no TreePM nunca troca de autor. Substituiu a ideia inicial de promover uma vez e nunca mais mudar, que a revisão mostrou não ter volta.
- **Nome de exibição que é um e-mail não é guardado**, nem para autor de comentário nem para criador de ticket. Achado da revisão, que bloqueou a fatia.
- O texto do comentário não fica em nenhuma cópia fora do próprio comentário: a origem guarda só uma marca do corpo.
- Um registro na linha do tempo por ticket e por página ("N comentários trazidos do Linear"), somados na leitura. Os comentários ficam fora da IA; pelo MCP saem só com o alcance de pessoas.
- Fica como está, por ora: comentários mais antigos que a importação aparecem acima do registro "criado" na linha do tempo.

## Como ficou (fatia 3, relações, 2026-11-25)

- Migration `0045_linear_relations`, só de acréscimo: `ticket_relations` aceita o tipo `related` (uma linha por par, menor id primeiro), `external_item_refs` aceita `relation`, a rodada ganha a fase `relations`, e as origens ganham a coluna gerada `relation_id` com índice e um índice por `local_id`. A coluna existe porque, com o isolamento por organização (RLS), o Postgres não usa índice de expressão sobre `applied` para o papel da aplicação.
- **Fase própria `relations`**, depois dos comentários, e não aninhada na leitura das issues: quando ela roda, as duas pontas já existem. Relê as issues do time só com o id e as 20 primeiras relações de cada uma (2.468 pontos com página de 50). A fase usa **página de 25**, para o passo não segurar a trava de dependências por mais de uns 2 s num projeto muito ligado. Issue com mais de 20 relações é lida em páginas extras no mesmo passo, até 4 por passo.
- `blocks` vira "depende de" no sentido inverso; `related` e `duplicate` viram "relacionado a", que aparece nos dois tickets e não entra em "bloqueado" nem na fila de trabalho. `similar` é ignorado.
- **Ciclo:** a dependência que fecharia ciclo com o que existe aqui não entra, é contada no resumo e é tentada de novo na sincronização seguinte. Nada feito aqui é desfeito.
- **Já existia igual aqui:** a origem adota a linha, sem duplicar, e a linha não ganha o selo "do Linear".
- **Editada no Linear** (sentido, ponta ou tipo trocados no mesmo id de relação): a linha antiga sai e a nova entra, como a seção 3 pede. Não vale para linha adotada (feita aqui por uma pessoa). Quando duas relações do Linear ligam o mesmo par, a linha só sai quando a última delas muda. A fase pega a trava de dependências antes de ler, e as remoções manuais pegam a mesma trava.
- **Removida aqui não volta**, enquanto os dois tickets forem os mesmos: a relação invertida ou trocada de tipo no Linear entre o mesmo par continua fora; se passar a ligar outro par, é relação nova e entra. Ticket apagado aqui e importado de novo é ticket novo: as relações dele voltam, seja qual for a ponta. A origem guarda os tickets das duas pontas para saber disso.
- **Sumida do Linear:** fica aqui, com a marca de "não encontrada desde". Só marca quando a leitura percorreu tudo.
- **Erro do Linear numa página de relações** (a chave não enxerga uma das pontas, por exemplo) não prende a rodada: se a resposta traz dados válidos junto do erro, eles são usados; senão a página é reduzida até isolar a issue, as relações dela são puladas e contadas como não lidas, e nada é marcado como removido naquela rodada. Depois de 10 issues seguidas ilegíveis a fase termina ali, e o resto do time fica sem ler naquela rodada (`TREEPM-518`). Achado da revisão, que bloqueou a fatia. O comportamento do Linear real nesse caso ainda não foi visto (`TREEPM-518`).
- Um registro na linha do tempo por ticket ("N relações trazidas do Linear"), somado na leitura. Atualização de relação não gera registro.
- "Relacionado a" pode ser removido na página do ticket por quem edita o ticket; não há criação pela tela. Pelo MCP, `get_ticket` traz `relations.related`. O assistente recebe os tickets relacionados nos mesmos termos dos de "depende de" (chave, título, situação). Nenhum id do Linear sai para provedor, MCP, evento ou log.
- Consequência a saber: dependências importadas deixam tickets "bloqueados" no mapa quando o ticket de que dependem está aberto. Na primeira sincronização isso pode mudar a cor de muitos cards de uma vez.
- Limite conhecido: página com mais de 4 issues com mais de 20 relações cada fica com leitura incompleta em toda rodada (`TREEPM-519`).

## Decisão da fatia 4: o histórico da issue (2026-11-25)

A seção 7 deixou a forma do histórico para depois da medição. A decisão, da coordenação por delegação (`TREEPM-482`; no mapa dos atributos Teodoro escreveu "traz a linha do tempo tbm"):

**A dor.** Quem abre um ticket importado vê uma linha do tempo que começa no dia da importação. O que aconteceu antes (quando entrou em andamento, quem passou para quem, quando voltou de revisão) ficou no Linear.

**1. O histórico do Linear não vira evento do TreePM.** Os eventos daqui alimentam outras coisas (reabertura do pai, notificações, o que cada pessoa fez, a data de conclusão). Gravar neles fatos antigos, com autores que não são pessoas daqui, mudaria essas contas. O histórico importado fica numa tabela própria, só de leitura, e a linha do tempo do ticket intercala as duas fontes pela data, com o selo "do Linear" nas entradas importadas.

**2. O que entra.** Só mudanças de coisas que o TreePM mostra hoje: situação (nome e tipo da coluna, de e para), responsável, prioridade, título, pai, projeto, e "descrição alterada" (sem o texto). Etiquetas, ciclo, estimativa, prazo e relações entram quando o atributo existir aqui; SLA, triagem, release e arquivamento não entram. Uma entrada do Linear que só traz coisas fora da lista é ignorada.

**3. Autor.** A mesma regra dos comentários (seção 5): pessoa do TreePM quando o e-mail casa; senão o nome de exibição no Linear, que não é guardado quando tem forma de e-mail; integração entra com o nome do robô. O responsável de e para segue a mesma regra.

**4. Custo.** O histórico vem aninhado na leitura das issues, numa fase própria `history`, depois das relações: 10 issues por página, com as 20 entradas mais recentes de cada uma, abaixo de metade do teto de complexidade. Issue com mais de 20 entradas é lida em páginas extras no mesmo passo, com teto de 200 entradas por issue. Na sincronização, a fase só relê as issues alteradas no Linear desde a última rodada que terminou; a primeira vez percorre o time inteiro (um time de 2.000 issues são 200 chamadas, com a espera do limite de taxa que a rodada já sabe fazer).

**5. Regras de item.** Entrada do histórico não é editada nem removida aqui, e não some: o Linear não apaga histórico, então não há marca de "não encontrada". Idempotência pela unicidade do id da entrada.

**6. Onde aparece e para onde vai.** Na linha do tempo da página do ticket, com a data original, antes do registro de importação. A criação no Linear (que a origem já guarda) aparece como a primeira entrada. Fora da IA e da Voyage, como todo dado de origem. Pelo MCP, `get_ticket_history` traz as entradas importadas só com o alcance de pessoas, com os nomes pelo caminho único de nomes e os textos do Linear (nome de coluna, título antigo) pelo limpador.

**7. Texto legal.** A linha do Linear na Política de privacidade ganha o histórico das issues, com os nomes de quem fez cada mudança.
