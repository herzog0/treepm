# ADR 0034 — Um só tipo de ticket, resolvido das folhas para o topo

**Status:** Aceita por Teodoro em 2026-11-21. A estrutura (primeira fatia) vai para implementação; a procura por tickets sem filhos (segunda fatia) espera uma resposta dele e uma medição. Substitui a primeira versão desta ADR, que propunha manter os agrupadores. **Data:** 2026-11-21.

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

## Consequências

- O `TREEPM-46`, que hoje não tem situação, volta a ter. Pela regra, ele só é concluído depois do 47 e do 48.
- Agrupadores de fase, como "Fechamento da Fase 1", passam a ser tickets: concluir o ticket é fechar a fase, e isso só é possível com os itens finalizados.
- O pai criado pela proposta da IA é um ticket a mais para concluir no fim.
- Com um só tipo, selecionar qualquer ticket no mapa e pedir "Novo ticket" procura dentro dele. Antes, só agrupador definia escopo.
- Mais candidatos por nível na segunda fatia. Na reconstrução do zero de 2026-11-20, a escolha acertou 4 de 5 julgamentos com até 10 candidatos e 14 de 34 com mais de 10.
- A regra de "desce ou fica" (item 3 da ADR 0033) continua em aberto e passa a valer um nível mais fundo.

## Em aberto

1. O texto exato da pergunta ao Jev para um ticket candidato, a medir.
2. O que fazer com os filhos abertos de um pai cancelado. Hoje: nada.
3. Se o ticket da vez ganha um destaque próprio no mapa além do card de situação.
