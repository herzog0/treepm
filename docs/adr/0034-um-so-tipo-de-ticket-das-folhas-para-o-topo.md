# ADR 0034 — Um só tipo de ticket, resolvido das folhas para o topo

**Status:** Aceita por Teodoro em 2026-11-21. A estrutura (primeira fatia) foi implementada no mesmo dia (PR #78, migration `0009_single_ticket_type`), ainda sem teste com sessão real. A procura por tickets sem filhos (segunda fatia) foi medida em 2026-11-21 e nenhuma regra foi adotada: a procura não muda, e a fatia fica parada até existirem mais tickets colocados à mão dentro de tickets sem filhos. As colunas do tipo antigo saíram do banco (PR #84, migration `0010_drop_ticket_kind`). Substitui a primeira versão desta ADR, que propunha manter os agrupadores. **Data:** 2026-11-21.

Substitui, na [ADR 0031](0031-agrupadores.md), o tipo declarado, a regra "só agrupador tem filhos" e as transformações entre tipos; na [ADR 0024](0024-tickets-primeiro-recorte-e-importacao-por-lista.md), a regra de que o ticket com filhos não tem situação própria; e ajusta, na [ADR 0033](0033-descricao-antes-da-procura-e-texto-fixo-do-agrupador.md), a quem se aplica o texto "O que entra aqui".

## Contexto

Depois de criar os tickets `TREEPM-46`, `47` e `48` pelo painel da IA, Teodoro achou contraintuitivo ter que transformar um ticket em agrupador para pôr outro dentro dele. A primeira versão desta ADR propôs tirar só o passo manual e manter os agrupadores. Ele recusou e explicou a ideia do produto:

> Não, a ideia é a seguinte, some agrupador, todo ticket pode ter filhos, mesmo as folhas. E a ideia de tudo isso é que a gente tenha um pensamento hierárquico que diz o seguinte: as folhas são as coisas que sempre têm que ser resolvidas primeiro. Quando um ticket de folha é resolvido, e aí um pai não tem mais nenhuma folha que não esteja resolvida, ou seja, todos estão resolvidos, ou deletados, ou enfim, finalizados de alguma maneira, então aquele ticket pai virou uma nova folha. E aí agora é esse ticket pai que tem que ser atacado, entendeu? Então a gente consegue ir resolvendo um projeto inteiro das folhas para o topo. Essa é a ideia do projeto. Então a gente precisa primeiro definir essa estrutura muito bem feita, né, da hierarquização das tarefas [...]. Só que em casos ambíguos, eu acho que está tudo bem a gente aceitar que eventualmente um ticket não vai voltar para o mesmo lugar que ele voltou em outra análise. [...] Mas a gente vai resolvendo caso a caso. Por enquanto, pega isso que eu falei e vamos partir daí.

## O que Teodoro decidiu

- **Um só tipo.** Não existe agrupador. Todo nó da árvore de um projeto é um ticket.
- **Todo ticket pode ter filhos**, inclusive o que hoje é folha.
- **O pai é trabalho de verdade.** Ele tem situação própria e é atacado depois dos filhos: quando todos os filhos estão finalizados (concluídos, cancelados ou removidos), o pai "virou uma nova folha".
- **O projeto é resolvido das folhas para o topo.**
- **O pai concluído que ganha um filho aberto é reaberto.** Dito no mesmo dia, em resposta à coordenação: "pai não pode ser concluído antes dos filhos serem concluídos. E se um filho novo for aberto depois do pai ser concluído, ele é reaberto tbm".
- **"Filho" quer dizer isto:** B é filho de A quando A não pode ser dado por pronto antes de B ("é isso sim").
- **Lugar ambíguo é aceitável.** A procura pode dar lugares diferentes para o mesmo ticket em análises diferentes; os casos são resolvidos um a um.
- **A estrutura vem primeiro.**

O que está marcado abaixo como *(escolha da coordenação)* não foi dito por ele.

## Primeira fatia — a estrutura

### Modelo

- O tipo (`kind`) deixa de existir na API, no domínio e na interface. O pai de um ticket é qualquer ticket do mesmo projeto que não seja ele mesmo nem um descendente dele, ou nenhum (raiz do projeto).
- Todo ticket tem situação, sempre, com os cinco valores de hoje. **Finalizado** é `done` ou `cancelled`; **aberto** é qualquer outro.
- **Ticket da vez:** ticket aberto que não tem nenhum descendente aberto. É a "folha" da frase de Teodoro, e é calculado, nunca guardado. Um ticket sem filhos e aberto é da vez; um pai passa a ser da vez quando o último descendente aberto é finalizado ou removido.
- **Finalizar o último filho não mexe na situação do pai** *(escolha da coordenação)*; ele só passa a aparecer como da vez.
- **Concluir um ticket que tem filho direto aberto é recusado** *(escolha da coordenação)*: 409 `ticket_has_open_children`, com a contagem. É a regra "as folhas primeiro" aplicada na hora de concluir. Cancelar um pai com filhos abertos é permitido e não mexe nos filhos.
- **Reabertura (decisão de Teodoro):** quando um ticket concluído passa a ter um filho direto aberto, ele é reaberto na mesma transação. Isso acontece ao criar um ticket aberto dentro dele, ao mover um ticket aberto para dentro dele e ao reabrir um filho dele. A reabertura sobe: se o pai do reaberto também estava concluído, é reaberto também, e assim por diante. Com isso, um ticket concluído nunca tem filho direto aberto.
  - O reaberto volta para "a fazer" (`todo`) *(escolha da coordenação)*.
  - O pai **cancelado** não é reaberto *(escolha da coordenação)*: cancelar não é concluir, e os filhos de um cancelado ficam como estão.
  - Cada reabertura grava o evento de mudança de situação de sempre, com a marca de que foi automática.
- **Progresso:** todo ticket com filhos traz `progress`, calculado sobre **todos** os descendentes, em qualquer nível, e agora os descendentes que também são pais contam como itens (cada um é um trabalho). `excluded` conta os cancelados, `total` os demais, `done` os concluídos. Ticket sem filhos traz `progress: null`.

### Dados existentes

- Nada é movido. Os agrupadores de hoje passam a ser tickets e voltam a mostrar a situação que está guardada no banco (a ADR 0031 preservava o valor ao transformar um ticket em agrupador).
- Em 2026-11-21 os 60 agrupadores do banco de desenvolvimento estavam todos guardados como "a fazer" (consulta da coordenação operacional), então nenhum ex-agrupador aparece concluído com filho aberto.
- **Migration em dois passos**, porque a migration chega ao banco de desenvolvimento antes do código:
  - `0009`: tira a exigência de `parent_kind` e a chave estrangeira que inclui o tipo, e recria a chave do pai só com organização, projeto e ticket. As colunas `kind` e `parent_kind` **ficam**, sem uso pelo código novo, para o servidor antigo continuar funcionando até a troca.
  - Uma migration seguinte remove as duas colunas, depois de o código novo estar no ar.

### API

- Some o campo `kind` de tickets, da criação, do `PATCH` e de cada item da importação por lista.
- Somem os erros `parent_not_group`, `group_has_no_status` e, na troca de tipo, `ticket_has_children`.
- `status` nunca é nulo.
- **Texto "O que entra aqui" (ADR 0033):** vale para ticket que tem filhos. `GET /api/tickets/:id/summary` responde para qualquer ticket (o texto guardado ou `null`). Gravar ou regenerar em ticket sem filhos: 409 `ticket_has_no_items`, que substitui `not_a_group` e `group_empty`. O texto guardado não é apagado quando o último filho sai.
- **Procura do caminho, por enquanto:** em cada nível, os candidatos são os tickets **que têm filhos**. É a regra de hoje sem o tipo, com os mesmos textos de pergunta. O ticket sem filhos só vira candidato na segunda fatia.
- **Escopo:** qualquer ticket selecionado define o escopo da procura. Se o escopo não tem filhos com filhos, a procura termina nele (quando a pergunta do escopo passa) ou diz que não cabe ali, como hoje. Ticket sem filhos entra na pergunta do escopo com o título e o trecho da descrição.
- **Bloco `groups` da conversa (ADR 0033):** passa a levar os títulos dos tickets que têm filhos naquele nível. O texto do prompt não muda nesta fatia.
- **Proposta de pai novo** (a "proposta de agrupador" da ADR 0031) *(escolha da coordenação)*: continua, e o que ela cria passa a ser um ticket comum, pai dos escolhidos.

### Web

- Somem "Novo agrupador", "Transformar em agrupador", "Transformar em ticket", a marca de tipo na lista de itens e o estado "vazio" do card. A palavra "agrupador" sai da interface.
- **Página do ticket:** toda página tem a seção de situação, a lista de itens (com estado vazio) e "Novo ticket aqui dentro". Ticket com filhos mostra também o progresso e "O que entra aqui". Ao tentar concluir com filho aberto: "Conclua ou cancele os N itens abertos antes de concluir este ticket."
- **Card no mapa** *(escolha da coordenação)*: o ticket que tem descendente aberto usa o card de progresso que o agrupador tem hoje ("n de m concluídos", cor pela mistura das situações dos descendentes). O ticket sem descendente aberto usa o card de situação que o ticket tem hoje. Assim o pai que "virou folha" passa a ter a mesma cara de uma folha, sem desenho novo e sem mudança de gesto.
- **Mudar o pai** lista todos os tickets do projeto, menos o próprio e os descendentes dele.
- **"Escolher no mapa"**, no painel da IA: o ticket clicado é o destino.
- **Proposta de pai novo:** a ação secundária passa a se chamar "Criar ticket pai e mover".

### Ferramenta de medição

O `export` e o `collect` passam a tratar como "grupo" o ticket que tem filhos. O mínimo para continuarem rodando.

### Como ficou na implementação (PR #78)

Pontos que a implementação decidiu além do texto acima:

- **Erros com detalhe.** As respostas de erro da API ganharam um campo opcional `error.details`; `ticket_has_open_children` traz `details.openChildCount`.
- **Corpo com `kind`:** 400 `validation_error`, como qualquer campo desconhecido.
- **Importação por lista:** um item `done` que tenha filho aberto na própria lista nasce `todo`; e a importação dentro de um pai concluído o reabre.
- **Evento da reabertura:** um `ticket.updated` por ticket reaberto, com `automatic: true` e `causedBy` (a chave do ticket que causou). O ator é a pessoa que fez a operação.
- **Texto guardado em ticket sem filhos:** `GET …/summary` o devolve, mas a procura usa o trecho da descrição enquanto o ticket não tiver filhos.
- **Código (ADR 0032):** `GET /api/tickets/:id/code` devolve os vínculos do ticket e de todos os descendentes, para qualquer ticket.
- **"Mudar o pai"** aplica a escolha no clique, sem confirmação; por isso o aviso da reabertura aparece depois ("«CHAVE» estava concluído e voltou para "A fazer"."). No cartão do caminho e em "Novo ticket aqui dentro" o aviso aparece antes.
- **Concorrência:** "concluir" trava a linha do ticket antes de contar os filhos, e a reabertura trava os ancestrais de baixo para cima antes de gravar o filho. Entre "concluir o pai" e "criar filho aberto" ao mesmo tempo, ou a conclusão é recusada, ou o pai é concluído e em seguida reaberto.
- **TDD:** quatro comportamentos da API têm cobertura mas não foram vistos falhando antes (candidatos só com filhos, escopo em ticket sem filhos, bloco `groups`, proposta criando ticket comum).

A migration `0010_drop_ticket_kind` (PR #84) removeu depois as colunas `kind` e `parent_kind` e o índice antigo.

## Segunda fatia — a procura considera todo ticket

O pedido de Teodoro: "escolhe um pai -> vê os filhos -> escolhe um filho que vai ser pai desse ticket -> assim por diante até achar o local certo", com toda folha como candidata.

- **A descida:** em cada nível, os candidatos são todos os tickets daquele nível; a procura escolhe um, desce e repete até parar. Ticket sem filhos entra com título e o trecho da descrição, sem chamada ao Claude.
- **A pergunta tem direção.** Teodoro confirmou o sentido de "filho": B fica dentro de A quando A não pode ser dado por pronto antes de B. Isso cobre "B é uma parte de A" e também "B precisa ficar pronto antes de A". No exemplo dele, o `TREEPM-48` (opções clicáveis na exportação) é filho do `47` (opção sem cabeçalho), porque o 47 depende do 48. O texto da pergunta ao Jev e o ajuste do prompt da conversa saem desse sentido.
- **O texto é testado com o Jev real antes de entrar**, com os casos de 2026-11-20 abaixo.

### O que a medição de 2026-11-20 diz

Com toda folha candidata (regra da [ADR 0030](0030-ticket-folha-como-candidato-na-procura-do-caminho.md)) e as perguntas de então, uma rodada, tirando um ticket por vez de uma cópia da árvore original:

| | Folhas candidatas | Só agrupadores (ADR 0031) |
| --- | ---: | ---: |
| Chegou ao grupo original | 21 | 23 |
| ...e ficou direto nele | 10 | 23 |
| ...e entrou em um ticket de dentro dele | 11 | 0 |
| Ficou na raiz | 15 | 13 |
| Foi para outro grupo | 3 | 3 |

- A decisão entre os grupos não piora (21 contra 23). A regra só acrescenta uma decisão a mais, dentro do grupo.
- O gabarito tem dois níveis, então todo ticket posto dentro de outro conta como erro por construção. Não serve para dizer se a regra é pior.
- Não há medição atual: as rodadas são anteriores à ADR 0033, e a ferramenta precisa reescrever o texto do pai sem o ticket testado para voltar a medir acerto.

Os 11 que entraram em um ticket vizinho:

| Ticket testado | Entrou dentro de |
| --- | --- |
| 6 — Buscar `/api/me` uma única vez por sessão | Reduzir as idas ao banco por requisição |
| 7 — Atualizar os papéis da pessoa depois de uma mudança de papel | Buscar `/api/me` uma única vez por sessão |
| 15 — Aplicar a base visual ao cabeçalho, ao painel lateral e à tela de times | Aplicar a base visual aos cards do mapa |
| 16 — Aplicar a base visual aos cards do mapa | Card em nível "detalhe" no mapa |
| 17 — Card em nível "detalhe" no mapa | Aplicar a base visual aos cards do mapa |
| 18 — Decidir se "cancelado" e "a fazer" têm cores diferentes no mapa | Aplicar a base visual aos cards do mapa |
| 20 — ADR 0024: modelo de ticket e importação por lista | Tela de importação de lista com prévia |
| 26 — Tela de importação de lista com prévia | Cliente da API e interpretador da lista na web |
| 27 — Inserir em lote na importação | ADR 0024: modelo de ticket e importação por lista |
| 28 — Importar esta lista no projeto TreePM | ADR 0024: modelo de ticket e importação por lista |
| 35 — Mudança de pai quando a edição muda a categoria | Busca do caminho do topo até a folha |

Teodoro aceitou a variação em casos ambíguos. Dois padrões dessa lista são de outra natureza e a pergunta nova precisa tratá-los:

- **A direção inverte.** O 16 entrou no 17 e, em outro teste, o 17 entrou no 16. A pergunta media "tem a ver com". No uso real, quem for criado primeiro vira o pai.
- **Um ticket vira ímã.** "Aplicar a base visual aos cards do mapa" recebeu quatro tickets.

Resultado bom, declarado antes de medir: chegar ao grupo original não cai (21 a 23 de 39); nos pares em que a direção inverteu, no máximo um sentido passa; Teodoro julga os tickets que entraram em outro ticket.

### Medição da pergunta, par a par (2026-11-21)

Comando `pairs` da ferramenta de medição (PR #84). Para cada ticket com pai, uma pergunta `Noul` por candidato: o pai real (com o texto escrito sem o ticket testado, e também só com título e descrição), cada irmão e cada outro ticket da raiz com filhos. Três redações: **W0**, a de hoje ("cabe dentro do assunto"); **W1**, dependência ("o candidato só pode ser dado por pronto depois que o trabalho do ticket estiver feito"); **W2**, parte ("o trabalho do ticket é uma parte do trabalho do candidato"). Três repetições por pergunta; vale a média. Duas rodadas independentes: a árvore original (39 testados, 539 pares) e a árvore de 2026-11-21 com os tickets 46 a 48 (41 testados, 596 pares).

Na árvore original, com os limites de hoje (acima de 0,7 é "sim"):

| | W0 | W1 | W2 |
| --- | ---: | ---: | ---: |
| Pai real reconhecido (de 39) | 25 | 1 | 18 |
| Pai real, só com título e descrição | 27 | 1 | 7 |
| Irmão aceito como pai (de 266 pares) | 73 | 0 | 13 |
| Pares de irmãos aceitos nos dois sentidos | 22 | 0 | 1 |
| Outro ticket da raiz aceito (de 195 pares) | 34 | 0 | 5 |
| Pai real com nota maior que todos os irmãos (de 39) | 21 | 17 | 27 |
| Pares cuja resposta muda de faixa entre repetições | 64 | 34 | 40 |

A rodada com a árvore de 2026-11-21 deu a mesma figura (pai real 29, 1 e 17; irmãos 70, 0 e 14; dois sentidos 18, 0 e 1).

O que os números mostram:

- **W0, feita ticket a ticket, aceita quase tudo.** É o defeito de 2026-11-20, agora medido.
- **W1 é rígida demais para servir de pergunta única:** não aceita irmão nenhum, mas reconhece 1 dos 39 pais reais. Os pais dessa árvore foram escritos como assuntos ("Design da plataforma"), e não como um trabalho que depende de partes.
- **W2 é a que mais separa o pai real dos irmãos,** e ainda assim reconhece menos da metade dos pais com o limite de hoje.
- **Nenhuma redação tem direção sozinha.** A nota de "A dentro de B" e a de "B dentro de A" andam juntas nas três (correlação entre 0,58 e 0,66). As redações novas ficam mais exigentes, e não mais direcionadas.
- **Comparando os dois sentidos da W1, a direção aparece em um subconjunto pequeno.** Pares de irmãos em que um sentido passa de 0,4 e supera o inverso em mais de 0,2: 11 em cada rodada, 9 em comum, nenhum invertido entre as rodadas. Os limites 0,4 e 0,2 foram escolhidos **depois** de ver a lista; não são uma regra validada.

O exemplo de Teodoro (os tickets 46, 47 e 48), em que ele disse que o 48 é filho do 47:

| Pergunta | W0 | W1 | W2 |
| --- | ---: | ---: | ---: |
| 48 dentro de 47 (o que ele disse) | 0,59 | 0,44 | 0,19 |
| 47 dentro de 48 (o inverso) | 0,95 | 0,23 | 0,74 |
| 47 dentro de 46, com 46 ainda sem filhos | 0,97 | 0,13 | 0,41 |
| 48 dentro de 46, com 46 ainda sem filhos | 0,95 | 0,14 | 0,42 |

- Só a W1 concorda com ele na direção entre 47 e 48, e com nota abaixo do limite de hoje. A W2 e a W0 apontam o sentido contrário.
- A W1 não colocaria o 47 nem o 48 dentro do 46. A W2 chega perto, sem passar do limite.
- **Os três tickets têm duas relações diferentes:** o 47 é uma parte do 46, e o 48 é um pré-requisito do 47. Nenhuma redação sozinha coloca os três.

Os pares em que a W1 deu direção nas duas rodadas (entra → dentro de), para Teodoro julgar:

| Entra | Dentro de |
| --- | --- |
| 22 — API de tickets com permissões por papel de projeto | 23 — Cliente da API e interpretador da lista na web |
| 13 — Proposta visual em alta fidelidade | 15 — Aplicar a base visual ao cabeçalho, ao painel lateral e à tela de times |
| 21 — Banco: tabelas de ticket com RLS | 25 — Aplicar a migration de tickets no banco de desenvolvimento |
| 20 — ADR 0024: modelo de ticket e importação por lista | 25 — Aplicar a migration de tickets no banco de desenvolvimento |
| 23 — Cliente da API e interpretador da lista na web | 26 — Tela de importação de lista com prévia |
| 26 — Tela de importação de lista com prévia | 28 — Importar esta lista no projeto TreePM |
| 44 — DNS de treepm.ai | 45 — Primeiro deploy e teste em produção |
| 34 — Busca do caminho do topo até a folha | 35 — Mudança de pai quando a edição muda a categoria |
| 2 — Testar as telas de administração com sessão real | 11 — Reduzir as idas ao banco por requisição |

O que ficou decidido naquele momento: nada na procura muda. A regra de comparar os dois sentidos da W1 esperava o julgamento de Teodoro sobre essa lista; ele deixou a decisão com a coordenação (seções abaixo). Pontos que qualquer proposta terá de resolver: a descida entre tickets que já têm filhos continua com a pergunta de lista de hoje; o que fazer quando um ticket cabe dentro de dois (a "Proposta visual" é pré-requisito de dois tickets, e a árvore só guarda um pai); e se a procura continua dentro do ticket escolhido.

### Referência cega e critério, fixados antes de rotular (2026-11-21)

Teodoro, sobre a lista acima: "Não sei dizer sobre as suas perguntas classificatórias. Vc é quem decide." E perguntou como a qualidade está sendo aferida, sugerindo comparar o Jev com a resposta de um modelo bom da Anthropic.

**O que a medição acima compara, de fato.** A referência é a própria árvore do projeto (`gabarito.json`): seis tickets na raiz e os filhos de cada um, quase toda vinda da lista que a coordenação importou. Ela é plana, então "irmão aceito como pai" conta como erro só porque a árvore não tem ticket dentro de irmão; ninguém julgou esses pares pelo sentido de "filho" que Teodoro definiu. O Claude aparece na medição só como resumidor (escreve o texto do ticket que tem filhos); não julga nada. E a árvore guarda o 48 dentro do 46, quando a única opinião de Teodoro sobre um par é o 48 dentro do 47.

**O que muda.** A decisão sobre a regra passa a ser da coordenação, medida contra uma referência escrita por um modelo da Anthropic, como ele sugeriu. A coordenação não rotula os pares ela mesma: já viu as notas do Jev.

Tudo abaixo foi escrito **antes** de a referência existir.

**Referência.**

- Entrada: os 48 tickets da árvore de 2026-11-21, só título e descrição, embaralhados e com rótulos neutros. Sem pai, sem número, sem situação, sem nota do Jev e sem a lista de nove pares.
- Dois rotuladores independentes (agentes novos, Claude Fable 5.2), cada um com um embaralhamento diferente. A instrução traz a definição de Teodoro (um ticket fica dentro de outro quando esse outro não pode ser dado por pronto antes dele) e nenhum exemplo deste projeto.
- Cada rotulador diz, para cada ticket, dentro de qual ticket ele fica (um, ou nenhum) e quais outros tickets também não podem ser concluídos antes dele. "Não dá para dizer" é resposta permitida.
- Rótulo de um par ordenado (A dentro de B): **sim**, quando os dois rotuladores marcaram a relação direta; **não**, quando nenhum marcou, nem direta nem por cadeia; **indeterminado** no resto, fora da conta.

**A referência só vale se:**

1. os dois rotuladores colocarem, sem serem levados a isso, o 48 dentro do 47 e o 47 dentro do 46;
2. das relações diretas marcadas por pelo menos um, 60% ou mais forem marcadas pelos dois.

Se falhar em qualquer um, não há referência, e a regra não é julgada por ela.

**Regra congelada (R).** Para dois tickets sem filhos, com a W1 (média das três repetições, rodada de 2026-11-21): "A entra em B" quando a nota de A dentro de B passa de 0,4 e supera a de B dentro de A em mais de 0,2. Os limites não são reajustados depois de a referência existir. Nenhuma chamada nova ao Jev: valem os arquivos já coletados.

**Critério.**

- Precisão de R: dos pares que R aceita e que têm rótulo, a parcela rotulada "sim" no mesmo sentido.
- **Adota-se R** como proposta da segunda fatia se a precisão for 0,8 ou mais, com pelo menos cinco pares com rótulo e nenhum aceito no sentido contrário ao da referência.
- **Descarta-se R** se a precisão ficar abaixo de 0,6 ou se dois ou mais pares saírem no sentido contrário.
- Entre os dois, R não é adotada como está.
- Cobertura (das relações "sim" entre irmãos, quantas R encontra): relatada, não decide. Cobertura baixa significa que a IA sugere pouco, e não que sugere errado.
- Para comparar, W0, W1 e W2 com o limite simples de 0,7 contra a mesma referência.

**Se R não for adotada,** a alternativa a propor é o modelo da Anthropic escolher o pai entre os filhos do destino, no fim da descida. A concordância entre os dois rotuladores já é uma primeira medida disso.

**Limites desta aferição.** Concordar com a referência quer dizer que o Jev concorda com o Claude, e não que os dois estão certos. É um projeto só, de 48 tickets, e muitos têm só o título.

### Resultado da referência cega (2026-11-21)

Arquivos em `~/.local/share/treepm-ops/rebuild-2026-11-20/referencia/` (entradas, rótulos, `score.py`, `resultado.md`). O `score.py` foi escrito antes de os rótulos existirem.

**A referência não passou no próprio teste.**

- Os dois rotuladores concordaram entre si: 51 relações diretas marcadas pelos dois, de 61 marcadas por pelo menos um (0,84); o mesmo pai em 42 dos 48 tickets; os mesmos 8 tickets no topo.
- Os dois, sem ver um ao outro, montaram os três tickets de Teodoro **ao contrário** do que ele disse: o 46 dentro do 47, o 47 dentro do 48 e o 48 no topo. Os motivos escritos: "a opção de tirar o cabeçalho pressupõe a exportação em CSV existente; a exportação não promete opções" e "a opção sem cabeçalho é uma das opções que a exportação com opções clicáveis precisa oferecer".
- O teste pedia o 48 dentro do 47. Nenhum dos dois marcou essa relação, nem direta nem por cadeia. (A outra metade do teste, o 47 dentro do 46, não vem de uma frase de Teodoro; a falha se sustenta só no par 47 e 48.)

**Consequência, pelo critério escrito antes:** não há referência, e a regra R não é julgada por ela. R não é adotada. As contagens de R contra esses rótulos estão em `resultado.md` e não são citadas aqui como precisão, porque os rótulos vêm de uma referência inválida.

**A alternativa anunciada cai junto.** O modelo da Anthropic escolher o pai no fim da descida não é proposto: a concordância de 0,84 mostra que ele é consistente, e não que acerta, e as duas rodadas inverteram o único par que Teodoro julgou. Também não foi testado na condição real (com a árvore existente à vista). Fica nem confirmado, nem refutado.

**O que dá para dizer sobre a causa, com cuidado.**

- A inversão pode vir da redação da instrução, e não das palavras de Teodoro. A instrução dizia "B é um pedaço do que A promete entregar", e um dos motivos repete esse termo ("a exportação não promete opções"). Ele disse só que o pai não pode ser concluído antes dos filhos.
- Hipótese, a partir de um único exemplo: pela regra de reabertura, o pai concluído é reaberto quando ganha um filho, então o que o pai entrega cresce com os filhos. Perguntar "o texto do pai já promete isto?" pode ser o teste errado.
- Refazer a rotulagem com outra redação até o exemplo sair certo não é feito: seria ajustar a referência a um exemplo.

**O problema de fundo:** o projeto tem **um** julgamento humano sobre "ticket dentro de ticket sem filhos" (o 48 dentro do 47). Nenhuma medição do Jev ou do Claude tem onde se apoiar enquanto for assim.

**Decisão da coordenação.**

- A procura não muda: desce pelos tickets que têm filhos, como hoje. Colocar um ticket dentro de um ticket sem filhos continua sendo ato da pessoa (o campo de pai, ou "Novo ticket" com o ticket selecionado no mapa).
- A segunda fatia fica parada. **Condição para reabrir:** existirem mais tickets colocados à mão, por pessoas, dentro de tickets que não tinham filhos. A exportação da árvore já os registra; eles viram a referência.
- Nenhuma capacidade nova no painel da IA sai daqui. Isso seria outra ADR e decisão de Teodoro.

## Consequências

- O `TREEPM-46`, que hoje não tem situação, volta a ter. Pela regra, ele só é concluído depois do 47 e do 48.
- Agrupadores de fase, como "Fechamento da Fase 1", passam a ser tickets: concluir o ticket é fechar a fase, e isso só é possível com os itens finalizados.
- O pai criado pela proposta da IA é um ticket a mais para concluir no fim.
- Com um só tipo, selecionar qualquer ticket no mapa e pedir "Novo ticket" procura dentro dele. Antes, só agrupador definia escopo.
- Mais candidatos por nível na segunda fatia. Na reconstrução do zero de 2026-11-20, a escolha acertou 4 de 5 julgamentos com até 10 candidatos e 14 de 34 com mais de 10.
- A regra de "desce ou fica" (item 3 da ADR 0033) continua em aberto e passa a valer um nível mais fundo.

## Em aberto

1. A procura dentro de tickets sem filhos (segunda fatia): parada, com a condição de reabertura em "Resultado da referência cega".
2. O que fazer com os filhos abertos de um pai cancelado. Hoje: nada.
3. Se o ticket da vez ganha um destaque próprio no mapa além do card de situação.
