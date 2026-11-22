# ADR 0037 — Relações entre tickets e camada de consulta do projeto

**Status:** Aceita por Teodoro em 2026-11-21 quanto à direção ("Segue a sua recomendação pras coisas em aberto"). A coordenação tinha recomendado a tabela de relações, a camada de consulta e gravar a ligação "menciona"; o restante desta ADR está marcado como escolha da coordenação e vale até ele dizer o contrário. A tabela, a ligação "menciona" e a camada de consulta foram implementadas em 2026-11-21 (PRs #100, #104 e #106); "depende de" também (PR #111); a pergunta sobre o projeto também, com a API (PR #109) e a barra (PR #114). As cinco fatias estão no `main`. Nada foi testado com sessão real e nenhuma chamada a provedor real foi feita. **Data:** 2026-11-21.

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

Dois pontos vão além da lista que a ADR 0036 propôs (título, trecho, situação, pai e rótulo): a descrição inteira, em vez do trecho, quando a IA lê um ticket; e as ligações. Os dois são texto e estrutura de ticket, sem dado de pessoa. A coordenação avisou Teodoro desses dois pontos em 2026-11-21 e disse que ele poderia vetá-los antes de a fatia 5 começar; ele não respondeu a esse aviso, e a fatia 5 foi implementada com os dois (PRs #109 e #114). **Os dois continuam podendo ser cortados:** a descrição inteira volta a ser o trecho mudando a saída de `read_ticket`, e as ligações saem da mesma saída, sem mudança de banco.

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

## Como ficou na implementação (fatias 1, 2 e 4)

**Tabela e domínio (PR #100, migration `0011_ticket_relations`)**

- A regra de menção ficou em `packages/domain` (`scanTicketKeys` e `mentionedKeys`). Uma lista única de 18 casos roda no teste do domínio e na suíte de navegador, que carrega cada caso no editor e confere as etiquetas desenhadas.
- **Um caso exigiu regra nova:** itálico com sublinhado (`_TREEPM-8_`). O editor desenha a etiqueta, e a leitura do markdown cru rejeitava a chave por estar colada no sublinhado; o domínio passou a desconsiderar o sublinhado que abre e fecha ênfase.
- **Não conta como menção:** bloco de código cercado, código em linha e o endereço de um link. Imagem em markdown continua sendo texto, como no editor.
- Fora da lista de casos: autolink e HTML.

**"Menciona" (PR #104)**

- Os caminhos que gravam descrição são três: criar (usado também pela conversa com a IA e pelo pai criado por uma proposta), importar por lista e alterar. Os três refazem as ligações na mesma transação.
- A importação faz um número fixo de consultas, qualquer que seja o tamanho da lista.
- Duas gravações simultâneas da mesma ligação não falham: a segunda é ignorada. O teste reproduziu a falha antes da correção.
- O detalhe do ticket devolve `mentionedBy`; a página mostra "Mencionado em" logo abaixo da descrição.
- **Preenchimento do que já existia:** subcomando `relations-rebuild` da ferramenta local, por uma rota de reconstrução do projeto (para quem pode alterar tickets). No projeto `TREEPM`, em 2026-11-21, leu 84 tickets e criou 2 ligações; a segunda execução não mudou nada.

**Camada de consulta (PR #106)**

- `ProjectQueryService`, sem rota HTTP, com quatro operações: `search`, `ticket`, `list` e `overview`. O ticket e o filtro "dentro de" são identificados pelo número.
- Confere em cada chamada que a pessoa enxerga o projeto. Nenhuma saída tem campo de pessoa nem data.
- Tetos: busca com 8 por padrão e 50 no máximo; listagem com 50 e 200; filhos, cada lista de ligações e tickets do topo com 200.
- Número fixo de operações de banco por chamada (2, 8, 3 e 3), conferido com 8 e com 80 tickets.
- A busca carrega os tickets do projeto e filtra em memória, como a barra faz no navegador. Em projeto muito grande isso pode pesar; não foi otimizado.
- A regra de busca da barra passou para `packages/domain`; a web delega a ela.

Suítes depois das três fatias: domain 237, db 186, api 1.272, web 1.341 e 81 na suíte de navegador.

## Como ficou na implementação (fatia 3 e a API da fatia 5)

**"Depende de" (PR #111)**

- Rotas `POST /api/tickets/:id/dependencies` e `DELETE /api/tickets/:id/dependencies/:ticketId`. Repetir uma ligação que já existe é sucesso sem efeito e sem evento.
- Recusas com código próprio: depender de si mesmo e fechar um ciclo.
- **Corrida do ciclo:** as requisições de adicionar dependência no mesmo projeto são serializadas por uma trava da transação. Sem ela, os testes de corrida falham.
- O detalhe do ticket devolve `dependsOn` e `blocks`.
- Na página: a linha "Depende de" nas propriedades, com seletor com busca, e a lista "Bloqueia" abaixo da descrição, junto de "Mencionado em".
- Um teste confere que concluir um ticket com dependência aberta continua permitido.

**Pergunta sobre o projeto, API (PR #109)**

- Rota `POST /api/projects/:projectId/assistant/ask`, com a pergunta e até 20 mensagens da conversa da tela. Quem enxerga o projeto pergunta.
- Quatro ferramentas: `search_tickets`, `read_ticket`, `list_tickets` e `project_overview`. O laço é o manual descrito na documentação do SDK, com 8 rodadas, 16 execuções e 60 segundos; ao bater o limite, uma última chamada sem ferramentas.
- **Rótulos:** `T` e o número. As chaves deste projeto nos textos viram rótulo na ida; na volta, só rótulo de ticket que existe vira chave. Chave de outro projeto fica como está no texto.
- Entrada inválida do modelo volta como erro da ferramenta, e a conversa segue.
- **Teto conferido por teste:** uma conversa com as quatro ferramentas é percorrida e tudo o que é entregue ao provedor é varrido atrás de id, chave do projeto, chave de ticket, nome e e-mail, com pessoas e responsáveis semeados para o teste ter o que achar.
- **Limites conhecidos:** um texto que traga literalmente `T<número>` de um ticket que existe volta como chave; chave escrita com zero à esquerda volta sem ele.

Suítes depois dessas duas: domain 237, db 186, api 1.362, web 1.360 e 84 na suíte de navegador.

**Testes de "transação aberta" (PR #110).** Contavam transações ociosas no servidor de banco inteiro, e suítes rodando em outros bancos do mesmo contêiner as faziam falhar. Passaram a olhar só o próprio banco.

## Como ficou na implementação (a barra da fatia 5, PR #114)

- A linha "Perguntar ao assistente sobre «texto»" fica no grupo de ações da folha, depois de "Criar ticket". Dispara por `Enter` na linha, clique ou `Shift+Enter` no campo *(o atalho é escolha da coordenação; o desenho aprovado mostrava `Tab`, que a ADR 0036 reservou para mover o foco)*.
- **Leitor pergunta:** a linha depende do assistente ligado e de haver projeto visível, não de poder criar tickets.
- **Projeto:** o do ticket aberto (ou da criação em curso), senão o do nó selecionado, senão o único visível; com mais de um, a folha pergunta "Em qual projeto?" e envia a pergunta quando a pessoa escolhe.
- A resposta é desenhada pelo mesmo componente que mostra a descrição, só para leitura; clicar em uma menção abre o ticket e recolhe a folha.
- **Estado só na tela:** nada vai para o banco nem para o armazenamento do navegador; recarregar a página apaga a conversa de perguntas.
- **Convivência:** uma folha aberta por vez. Com as duas recolhidas, a barra mostra "Conversa em andamento" e "Pergunta em andamento" lado a lado; em barra estreita o texto do campo é cortado.
- "Nova pergunta" encerra a folha e leva o foco ao campo da barra. Pergunta nova vinda da barra, com uma folha recolhida no mesmo projeto, continua a mesma conversa.
- Erro com texto próprio ("O assistente não respondeu. Tente de novo."), porque o texto comum manda criar o ticket manualmente.
- Web com 1.395 testes e 85 na suíte de navegador. Nenhuma chamada a provedor real foi feita.
