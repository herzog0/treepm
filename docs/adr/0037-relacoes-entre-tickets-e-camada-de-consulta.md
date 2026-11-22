# ADR 0037 — Relações entre tickets e camada de consulta do projeto

**Status:** Aceita por Teodoro em 2026-11-21 quanto à direção ("Segue a sua recomendação pras coisas em aberto"). A coordenação tinha recomendado a tabela de relações, a camada de consulta e gravar a ligação "menciona"; o restante desta ADR está marcado como escolha da coordenação e vale até ele dizer o contrário. Nada foi implementado. **Data:** 2026-11-21.

Muda, na [ADR 0036](0036-barra-de-pedidos-e-pagina-do-ticket-em-blocos.md), a regra de que a menção é guardada só como a chave no texto (a chave continua, e passa a existir também uma ligação gravada) e a forma de responder a pergunta sobre o projeto (a IA consulta, em vez de receber todos os tickets). Não muda a árvore, o significado de "filho" nem a procura do lugar do ticket novo ([ADR 0034](0034-um-so-tipo-de-ticket-das-folhas-para-o-topo.md)).

## Contexto

Em 2026-11-21 Teodoro perguntou:

> me parece importante a gente repensar a nossa estrutura de dados pra algo com o qual seja possível construir um knowledge graph depois, não? pra que a gente consiga usar a base de dados quase que como um servidor mcp de cada projeto, e a IA seja, além de tudo, mais eficiente. isso demanda uma refatoração muito grande né

A resposta da coordenação foi que a direção faz sentido e que o que falta é aditivo. Ele respondeu "Segue a sua recomendação pras coisas em aberto".

O que o banco já tem:

- **Coisas com identidade estável e isolamento por organização:** organização, pessoa, time, área, projeto, ticket, repositório, conversa.
- **Ligações com tabela própria:** ticket dentro de ticket (`parent_id`), pessoa responsável por ticket, ticket ligado a branch ou pull request, projeto ligado a time e a repositório.
- **Histórico:** os eventos de atividade de cada ticket.

O que falta:

- **Ligação entre tickets além de pai e filho.** A menção (ADR 0036) existe só como texto na descrição: não dá para perguntar ao banco "quem menciona este ticket".
- **Uma forma de consultar o projeto como um todo.** A web carrega todos os tickets e resolve tudo no navegador; a IA só recebe o que cada chamada monta à mão.
- **Entrada sem sessão de navegador,** que um cliente MCP exige.

A medição da ADR 0034 mostrou ainda que os três tickets de exportação de Teodoro carregam duas relações diferentes na mesma árvore: "é parte de" e "precisa ficar pronto antes".

## Decisão

### O banco continua PostgreSQL, com uma tabela por tipo de ligação

- O grafo é o que já existe mais uma tabela de relações entre tickets. Nenhuma tabela atual muda.
- A camada de consulta apresenta as ligações de forma uniforme; o banco continua com chaves estrangeiras e isolamento por organização em cada tabela.

### Tabela `ticket_relations` (migration `0011`)

- **Colunas:** `org_id`, `id`, `project_id`, `from_ticket_id`, `to_ticket_id`, `kind`, `created_at`, `updated_at`.
- **Tipos (`kind`, com check no banco):** `mentions` e `depends_on`.
- **Sentido:** "de" menciona "para"; "de" depende de "para".
- **Mesmo projeto:** as duas pontas são do mesmo projeto, garantido pelas chaves estrangeiras `(org_id, project_id, id)`, como na árvore. Remover um ticket remove as ligações dele.
- **Regras no banco:** um ticket não se liga a si mesmo; no máximo uma ligação por par e tipo.
- **Índice** pela ponta "para", para a lista de quem aponta para um ticket.
- **Isolamento por organização** e concessão ao papel da aplicação iguais aos das outras tabelas ([ADR 0021](0021-neon-postgres-e-rls-por-organizacao.md)).

### "Menciona": derivada da descrição

- **O texto continua sendo a fonte.** A chave fica na descrição, como na ADR 0036. A ligação é um índice do texto: ninguém a cria nem a remove à mão.
- **Uma só definição de menção.** A regra que hoje vive na web (chave solta de um ticket que existe no mesmo projeto; trecho de código não conta) passa para `packages/domain`, em uma função que lê a descrição em markdown, e a web e a API usam a mesma.
- **Quando grava.** Toda escrita de descrição (criar, alterar, importar por lista, criar pela conversa, criar o pai de uma proposta, ferramenta local) refaz as ligações `mentions` que saem daquele ticket, na mesma transação. As ligações de outros tipos nunca são tocadas por isso.
- **Chave escrita antes de o ticket existir.** Ao criar um ticket, as descrições do projeto que já citam a chave nova ganham a ligação.
- **Sem evento próprio.** A mudança da descrição já é registrada.
- **Descrições que já existem:** um subcomando da ferramenta local refaz as ligações de um projeto com a mesma função. A migration não interpreta texto.
- **Na página do ticket:** uma lista "Mencionado em", com os tickets que citam o que está aberto. Some quando está vazia.

### "Depende de": registrada pela pessoa *(escolha da coordenação)*

Teodoro não foi consultado sobre este desenho; a coordenação tinha dito que não mexeria na definição de "filho" sem ele. Por isso entra só a forma que não muda nada do que existe:

- **O que é:** "este ticket precisa que aquele fique pronto antes". Um ticket pode depender de vários.
- **O que não muda:** a árvore, o significado de "filho", os tickets que já existem, a regra de concluir e reabrir e a procura da IA. Nenhum ticket é movido, e a situação de um ticket não é alterada por causa de uma dependência.
- **Ciclo é recusado** (direto ou por vários passos), por uma função pura do domínio.
- **Quem pode:** quem pode alterar o ticket.
- **Evento:** adicionar e remover gravam um evento de atividade no ticket de origem.
- **Na página do ticket:** uma linha "Depende de", onde se adiciona e remove, e a lista "Bloqueia" com o outro lado.
- **No mapa:** nada é desenhado.

### Camada de consulta do projeto

Um serviço só de leitura na API, sobre um projeto por vez:

- **Buscar** tickets por texto, com a mesma regra da barra (a função de busca passa para `packages/domain`).
- **Ler um ticket** com pai, filhos, caminho até a raiz e ligações nos dois sentidos.
- **Listar** tickets por situação e, opcionalmente, dentro de um ticket.
- **Resumo do projeto:** quantos tickets por situação e os tickets do topo com o progresso.

Regras:

- **Permissão:** só responde sobre projeto que a pessoa enxerga, pela mesma conferência das rotas de hoje.
- **Sem escrita.** Nenhuma operação da camada altera dados.
- **Tamanho limitado.** Toda lista tem teto e diz quando foi cortada.
- Não ganha rota HTTP nesta ADR. Os dois consumidores são a pergunta sobre o projeto (abaixo) e, depois, o servidor MCP.

### Pergunta sobre o projeto *(mecanismo recomendado; detalhes são escolha da coordenação)*

Substitui o envio descrito na ADR 0036, em que cada pergunta levaria todos os tickets do projeto.

- **A IA consulta.** O Claude recebe a pergunta e quatro ferramentas (buscar, ler ticket, listar, resumo), que são a camada de consulta com a saída reduzida. O servidor executa as chamadas e devolve os resultados, com limite de rodadas e de tempo.
- **Um projeto por pergunta:** o do ticket aberto ou selecionado; sem isso, o único projeto visível; com mais de um, a pessoa escolhe.
- **A conversa não é guardada no banco.** Fica na tela, e cada pergunta reenvia as anteriores.

**O que vai à Anthropic, e nada além disso:**

- a pergunta e a conversa;
- por ticket consultado: título, descrição, situação, o pai, os filhos e as ligações (`mentions`, `depends_on`);
- um rótulo neutro por ticket (`T` e o número, como `T47`) no lugar da chave e do id. Nos textos enviados, a chave de um ticket do projeto é trocada pelo rótulo; na resposta, o código troca de volta.

**O que não vai:** nome, e-mail ou qualquer dado de pessoa (responsáveis, autor); ids; a chave do projeto; histórico de atividade; branches e pull requests; conversas de novo ticket; tickets de outros projetos. Nada do conteúdo entra em log.

Dois pontos vão além da lista que a ADR 0036 propôs (título, trecho, situação, pai e rótulo): a descrição inteira, em vez do trecho, quando a IA lê um ticket; e as ligações. Os dois são texto e estrutura de ticket, sem dado de pessoa. Teodoro pode vetar qualquer um antes de a fatia 5 começar.

### Servidor MCP por projeto: autorizado, com ADR própria antes do código

Em 2026-11-21, depois desta ADR, Teodoro respondeu "Mcp com token por pessoa tbm".

- Seria uma porta MCP sobre a camada de consulta, com as mesmas permissões.
- Exige um token por pessoa, que é a primeira entrada sem sessão de navegador. Isso pede uma ADR própria, a 0038 (emissão, revogação, validade, alcance e registro de uso), e o código vem depois da camada de consulta.

## Fatias

1. **Tabela e domínio** (`TREEPM-74`): migration `0011`, a função de menção e a regra de ciclo em `packages/domain`, e a web usando a função compartilhada. Sem mudança visível.
2. **"Menciona"** (`TREEPM-75`): gravação em toda escrita de descrição, subcomando de preenchimento e "Mencionado em" na página do ticket.
3. **"Depende de"** (`TREEPM-76`): rotas de adicionar e remover, evento, linha na página do ticket e "Bloqueia".
4. **Camada de consulta** (`TREEPM-77`), com a busca no domínio.
5. **Pergunta sobre o projeto** (`TREEPM-79`), na barra.

"Pedir ao assistente para escrever" (`TREEPM-80`) segue a ADR 0036 e não depende desta. O servidor MCP (`TREEPM-78`) espera a ADR própria.

A migration da fatia 1 é aplicada no Neon de desenvolvimento pela coordenação operacional antes de o servidor local receber o código. Todo texto novo entra no catálogo nos três idiomas (ADR 0035), e todo comportamento novo começa por um teste que falha.

## Alternativas descartadas

- **Banco de grafos.** Nesse tamanho o PostgreSQL percorre a árvore e as ligações sem dificuldade, e a troca seria a refatoração grande, sem ganho agora.
- **Uma tabela genérica de arestas entre qualquer coisa** (tipo e id de cada ponta). Perderia as chaves estrangeiras e a garantia de mesmo projeto; as ligações que já existem têm tabela própria e funcionam.
- **Menção sem ligação gravada** (ADR 0036, como estava). Serve para desenhar a etiqueta, mas não responde "quem menciona este ticket" sem ler todas as descrições.
- **Enviar todos os tickets a cada pergunta.** Custa mais a cada pergunta e cresce com o projeto; com as ferramentas, a IA pede só o que precisa.
- **Separar "é parte de" de "depende de" movendo tickets que já existem.** Mudaria a árvore de Teodoro sem ele ter decidido.

## Em aberto

1. Ligações entre tickets de projetos diferentes.
2. Outros tipos de ligação ("relacionado a", "duplica").
3. Se a procura do lugar do ticket novo passa a usar "depende de" (a segunda fatia da ADR 0034 continua parada).
4. Se as dependências aparecem no mapa.
5. O token por pessoa e o servidor MCP (ADR própria).
6. O idioma do texto escrito pela IA (`TREEPM-56`).
