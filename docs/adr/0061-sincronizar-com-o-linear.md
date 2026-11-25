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

"Vazio" é definido por atributo na fatia dele (texto vazio, lista vazia, nulo). Prioridade 0 e situação não contam como vazio: os dois já têm retrato desde a primeira importação.

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
- **Nada do que esta ADR traz vai a provedor de IA, à Voyage ou ao MCP.** Comentários já ficam fora; nome de autor do Linear, datas e identificadores antigos também. Cada fatia futura declara o mesmo ponto para o atributo dela, e o padrão é fora.
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
