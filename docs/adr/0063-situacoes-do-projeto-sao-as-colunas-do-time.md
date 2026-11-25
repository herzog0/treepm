# 0063 — Situações do projeto: as colunas do time, por cima de cinco categorias fixas

- **Data:** 2026-11-25
- **Situação:** pedido de Teodoro em 2026-11-25 (`TREEPM-472`). No mapa dos atributos do Linear, ele marcou "nome livre da situação" como implementar, com a nota "adiciona mais status possíveis pra nossa aplicação, pensa na lógica de propagação de cor só". Perguntado se queria uma lista fixa maior ou as colunas do time, respondeu: "que use as colunas do time". O desenho abaixo é da coordenação e **espera a aprovação dele nas telas**, que passam pelo Claude Design, porque muda o marcador de situação do mapa aprovado. Completa a [ADR 0061](0061-sincronizar-com-o-linear.md) e se apoia na [ADR 0051](0051-cores-por-situacao-e-propagacao-do-mais-preocupante.md).

## Contexto

O ticket do TreePM tem uma de cinco situações fixas: a fazer, em andamento, em revisão, concluído, cancelado. Muita coisa depende desse conjunto fechado: a cor do card e a propagação para o pai (ADR 0051), "bloqueado" como derivado, a regra do concluído com filho aberto, a fila de trabalho, o progresso, o MCP, o que vai ao assistente.

No Linear cada time tem as próprias colunas, com nome livre ("In Review", "QA", "Ready for deploy", "Icebox"). Cada coluna tem um **tipo** de um conjunto fechado: `triage`, `backlog`, `unstarted`, `started`, `completed`, `canceled`, `duplicate`. Hoje a importação lê só o tipo e joga fora o nome: um time com quatro colunas de trabalho em andamento vê todas como "em andamento".

A dor: quem trabalha no Linear pensa nas colunas dele. Ao abrir o TreePM, "QA" e "In Review" viraram a mesma coisa, e a pessoa perde a informação que usa todo dia.

## Decisão

### 1. Duas camadas: a categoria manda, a coluna nomeia

- A situação de hoje passa a se chamar **categoria** e continua sendo o conjunto fechado de cinco. Nada do que depende dela muda: cor, propagação, bloqueado, concluído com filho aberto, fila, progresso.
- Cada projeto ganha uma lista de **colunas**: nome, categoria a que pertence, ordem. Um ticket tem uma categoria (como hoje) e, opcionalmente, uma coluna do projeto dentro dessa categoria.
- A cor continua sendo a da categoria. Duas colunas da mesma categoria têm a mesma cor, e o que as distingue é o nome escrito. É o que a nota dele pedia: a propagação de cor não ganha caso novo.
- Ticket sem coluna mostra o nome padrão da categoria, como hoje. Projeto sem colunas próprias funciona exatamente como hoje.

**Por que não uma lista fixa maior.** Qualquer lista fixa erra o nome de alguém, e cada item novo pede um lugar na ordem de cor.

**Por que não colunas totalmente livres, sem categoria.** A cor do mapa precisa saber o que é "em andamento" e o que é "acabou". Sem categoria, cada projeto teria de configurar a regra de propagação, e o mapa deixaria de ser lido igual de um projeto para outro.

### 2. De onde vêm as colunas

- Em projeto ligado a um time do Linear, as colunas são as do time, lidas na sincronização: nome, ordem e tipo. A categoria inicial sai do tipo:

| Tipo no Linear | Categoria no TreePM |
| --- | --- |
| `triage`, `backlog`, `unstarted` | a fazer |
| `started` | em andamento |
| `completed` | concluído |
| `canceled`, `duplicate` | cancelado |

- O Linear não tem tipo "em revisão". Quem administra o projeto pode trocar a categoria de uma coluna de tipo `started` para "em revisão" (por exemplo "In Review" e "QA"), numa tabela nas configurações do projeto. Essa escolha é do TreePM e a sincronização não a desfaz.
- Coluna renomeada, reordenada ou criada no Linear acompanha na sincronização seguinte. Coluna apagada lá fica aqui enquanto houver ticket nela, marcada como "não existe mais no Linear".
- Em projeto sem Linear, as colunas ficam como estão hoje (uma por categoria, com o nome padrão). Editar colunas à mão num projeto sem Linear é o passo seguinte natural e fica fora deste recorte.

### 3. O ticket

- Na sincronização, o ticket recebe a coluna da issue. A regra por campo da ADR 0060 vale para a coluna como valia para a situação: só muda o que mudou no Linear e não foi mexido aqui.
- Na primeira sincronização depois desta fatia, os tickets já importados ganham a coluna pela regra do campo sem retrato (ADR 0061): quem ainda está na categoria que a importação pôs recebe a coluna; quem teve a situação mexida aqui fica como está.
- A regra do concluído com filho aberto continua: o ticket nasce "a fazer", sem coluna, e o retrato guarda as duas coisas para não haver vaivém.
- Mudar a situação na tela passa a ser escolher uma coluna; a categoria vem junto. Onde só existe a categoria (MCP antigo, importação por lista, regras automáticas como a reabertura do pai), o ticket vai para a primeira coluna daquela categoria na ordem do projeto.

### 4. Onde o nome da coluna aparece

- Na página do ticket, no seletor de situação, agrupado por categoria.
- No marcador de situação do card, quando o nível de detalhe mostra texto: o nome da coluna no lugar do nome da categoria. A forma e a cor do marcador continuam as da categoria.
- Nos filtros e na busca por situação: por categoria (como hoje) e por coluna.
- No MCP: as leituras trazem a coluna ao lado da categoria; `update_ticket_status` aceita a categoria ou o nome de uma coluna.
- No assistente: o nome da coluna vai junto da situação. É texto de configuração do projeto, não é dado de pessoa.

### 5. O que não muda

- As cinco categorias, as cores e a regra de propagação da ADR 0051.
- "Bloqueado" continua derivado das dependências.
- Layout, níveis de detalhe, zoom e gestos do mapa.

## Telas que passam pelo Claude Design antes da implementação

1. O seletor de situação da página do ticket, com colunas agrupadas por categoria.
2. O marcador do card com nome de coluna, nos níveis de detalhe que mostram texto, incluindo nome longo.
3. A tabela de colunas nas configurações do projeto, com a troca de categoria.

## Fatias

1. **Banco e sincronização:** colunas do projeto, coluna no ticket, leitura das colunas do time, regra por campo.
2. **Tela:** seletor, marcador, tabela de configurações, filtros.
3. **MCP e assistente.**

## Em aberto

- Se "triage" e "backlog" merecem aparência diferente de "a fazer" (por exemplo, mais apagados). Hoje ficam todos na mesma categoria; decidir olhando o mapa de um time real.
- Editar colunas em projeto sem Linear.

## Consequências

- O nome da situação deixa de ser igual em todos os projetos; o que continua igual é a cor.
- Todo lugar que mostra a situação por escrito precisa caber um nome livre, que pode ser longo.
- A escolha de categoria por coluna é configuração nova, feita por quem administra o projeto.
