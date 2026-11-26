# 0065 — Etiquetas por projeto

- **Data:** 2026-11-26
- **Situação:** pedido de Teodoro em 2026-11-25 (`TREEPM-466`). No mapa dos atributos do Linear ele marcou "Etiquetas" (I-01: "etiquetas por projeto, com cor, filtro no mapa e na busca") como implementar. O desenho abaixo é da coordenação, por delegação. O que muda o mapa (filtro e etiqueta no card) **espera a aprovação dele na tela**, pelo Claude Design. Completa a [ADR 0061](0061-sincronizar-com-o-linear.md).

## Contexto

A árvore diz onde o ticket mora, e a situação diz em que pé ele está. Falta um jeito de marcar o que atravessa a árvore: "bug", "dívida técnica", "cliente X", "precisa de decisão". No Linear isso são as etiquetas, e quem importa de lá perde todas.

A dor não é ter a palavra escrita no ticket: é **achar e ver junto** o que tem a mesma marca, espalhado pela árvore. Por isso o filtro no mapa é o centro do atributo, e a etiqueta sem filtro seria só decoração.

**Etiqueta não é área.** O TreePM já tem áreas: são as disciplinas da organização (design, engenharia), valem para a organização inteira e carregam a contribuição de cada disciplina no ticket. Etiqueta é do projeto, livre, sem estado. Um time que usa no Linear etiquetas com nome de disciplina ("Frontend") vai ter as duas coisas; a importação não tenta adivinhar que uma etiqueta é uma área.

## Decisão

### 1. O que é

- Cada **projeto** tem a própria lista de etiquetas: nome (até 60 caracteres, único no projeto sem diferenciar maiúsculas) e cor. Não há etiqueta da organização: o pedido é por projeto, e uma lista global vira depósito.
- Um ticket tem zero ou mais etiquetas do projeto dele. Limite de 20 por ticket e de 200 por projeto, para o seletor e o filtro continuarem usáveis.
- Etiqueta não tem hierarquia, não é herdada pelos filhos e não muda cor de card, propagação, fila nem progresso.

### 2. Cor

- A cor vem de uma **paleta fixa de oito**, escolhida para ler bem no tema escuro e no claro e para não se confundir com as cinco cores de situação do mapa (ADR 0051). Cor livre deixaria alguém pintar uma etiqueta com o verde de "concluído" e o mapa passaria a mentir.
- A cor do Linear (qualquer hexadecimal) é convertida para a mais próxima da paleta na importação.

### 3. Quem mexe

- Quem pode editar o ticket põe e tira etiquetas, e **cria uma etiqueta nova digitando o nome** no seletor: se criar etiqueta exigir ir às configurações, ninguém cria.
- Renomear, trocar a cor e apagar é de quem administra o projeto, numa lista nas configurações do projeto. Apagar tira a etiqueta de todos os tickets, com confirmação que diz quantos.
- Pôr e tirar etiqueta vira evento na linha do tempo do ticket. Sem notificação.

### 4. Onde aparece

- **Página do ticket:** campo "Etiquetas" com as etiquetas como pastilhas coloridas e o seletor com busca e criação.
- **Mapa** (espera aprovação, ver abaixo): **o mapa não tem filtro hoje; este é o primeiro.** Filtrar por etiqueta mantém a árvore no lugar e apaga visualmente o que não tem a etiqueta, com um resumo ("4 de 31 tickets") e um "Limpar". O mesmo filtro recebe "atrasados" ([ADR 0064](0064-prazo-no-ticket.md)). No card, nos níveis de detalhe com texto, cada etiqueta é uma pastilha escura com um ponto de cor e o nome; as que não cabem viram "+2". A cor do card continua sendo só a situação. De longe, sem texto, o card não mostra etiqueta.
- **Busca:** por etiqueta, sozinha ou junto de texto.
- **MCP:** as leituras de ticket trazem os nomes das etiquetas; `list_labels` lista as do projeto; `update_ticket` e `create_ticket` aceitam etiquetas pelo nome (criando as que não existem, com o alcance de escrita).
- **Assistente:** os nomes das etiquetas **não vão ao provedor de IA** nesta ADR. É texto de configuração do projeto e ajudaria o assistente ("quais bugs estão abertos?"), mas é categoria nova de dado e uma etiqueta pode ser o nome de um cliente ou de uma pessoa. Fica perguntado a Teodoro, junto com o prazo (ADR 0064).

### 5. Linear

- As etiquetas das issues importadas viram etiquetas do projeto: só as que alguma issue importada usa, não o catálogo inteiro do workspace. O vínculo é pelo identificador da etiqueta no Linear; renomear lá renomeia aqui, a menos que o nome tenha sido mudado aqui.
- Grupo de etiquetas do Linear não existe aqui: a etiqueta entra com o próprio nome. Se duas etiquetas de grupos diferentes têm o mesmo nome, a segunda entra com o nome do grupo na frente.
- Etiqueta do Linear com o mesmo nome de uma etiqueta que já existe no projeto é **adotada**: não nasce uma segunda.
- No ticket, vale a regra das coisas que são muitas por ticket (ADR 0061, seção 3): etiqueta posta no Linear chega; tirada no Linear sai daqui, se não foi posta aqui; tirada aqui não volta; posta aqui fica.
- Nada da origem (identificador da etiqueta no Linear) vai a provedor de IA nem sai pelo MCP.

## Telas que passam pelo Claude Design antes da implementação

1. O filtro por etiqueta no mapa.
2. As etiquetas no card, nos níveis de detalhe com texto.

O campo na página do ticket e a lista nas configurações seguem os padrões que já existem e não esperam.

## Fatias

1. **Banco, API, página do ticket, linha do tempo, configurações do projeto, MCP e Linear.** Não toca no mapa.
2. **Filtro no mapa, etiqueta no card e busca**, depois da aprovação da tela.

## Alternativas descartadas

- **Usar as áreas como etiquetas.** Área é disciplina da organização, com contribuição e estado; misturar marcas livres ali estragaria as duas coisas.
- **Etiquetas da organização, compartilhadas entre projetos.** Útil para quem quer ver "bug" em tudo, mas pede governança (quem cria, quem apaga) e não foi o que ele pediu. Pode vir depois, por cima desta.
- **Cor livre.** Ver a seção 2.

## Em aberto

- Nomes de etiqueta no assistente (pergunta a Teodoro).
- Filtro por etiqueta atravessando projetos, no mapa da organização.

## Consequências

- O mapa ganha o primeiro filtro que não segue a árvore nem a situação.
- Mais um conjunto por ticket para a sincronização do Linear acompanhar, com a mesma regra dos comentários e das relações.

## Como ficou (fatia 1, 2026-11-26)

- Migration `0048_ticket_labels`, só de acréscimo: `project_labels`, `ticket_labels` (a chave estrangeira composta garante que a etiqueta é do mesmo projeto do ticket) e `project_label_origins`, com RLS forçada; `external_item_refs` aceita `label`. Exige Postgres 15 ou mais.
- **Nome único sem depender do banco.** A chave de unicidade do nome é calculada no domínio (NFKC e minúsculas sem localidade), e não por `lower()` do Postgres, que depende da localidade de cada banco. A tela usa a mesma chave para decidir quando mostrar "Criar «texto»".
- **Nome que o banco recusaria é inválido antes de chegar lá.** Caracteres invisíveis e de direção saem do nome ("bug" com um espaço de largura zero é a mesma etiqueta "bug"), e nome cuja chave normalizada passa de 240 caracteres é recusado. A revisão achou que um nome assim, vindo do Linear, dava erro e prendia a sincronização; corrigido, com uma lista de casos conferida contra o domínio e contra o banco.
- **Linear, até dez etiquetas por issue:** a consulta detalha dez por issue; as demais só entram se outra issue as trouxer (`TREEPM-547`).
- **Paleta:** `gray`, `brown`, `orange`, `olive`, `cyan`, `indigo`, `violet`, `rose`, todas a uma distância perceptual mínima das cinco cores de situação, da cor de ideia e da cor de destaque.
- **A origem da etiqueta no Linear fica em tabela própria** e sobrevive ao apagar: é o que impede a etiqueta apagada aqui de renascer na sincronização seguinte.
- **Apagar uma etiqueta grava um evento no projeto, não um por ticket.** Na linha do tempo do ticket ficam só o pôr e o tirar, com o nome que a etiqueta tinha na época.
- **Leituras sem consulta por ticket:** as etiquetas de uma lista vêm numa consulta só, com teste de contagem.
- **MCP:** leituras com os nomes (pelo limpador de texto, sem identificador); `list_labels`; `update_ticket` com `addLabels` e `removeLabels` e `create_ticket` com `addLabels`. Acrescentar e tirar, em vez de mandar o conjunto: um cliente que esquece uma etiqueta não apaga nada.
- **Linear:** as etiquetas vêm na própria leitura das issues (1.768 pontos com página de 50, contra 413 antes), sem fase nova. A issue traz o conjunto completo de identificadores, então tirar no Linear não depende de quantas etiquetas a página detalha. Etiqueta com nome igual ao de uma daqui é adotada e não muda de nome nem de cor pela sincronização.
- **IA:** nomes de etiqueta não vão a nenhum provedor; teste com nome sentinela em todos os caminhos, quebrado de propósito duas vezes para provar que pega.
- **Mover ticket entre projetos não existe hoje.** Se existir, a chave estrangeira recusa a mudança enquanto houver etiqueta, em vez de deixar etiqueta de outro projeto pendurada.
