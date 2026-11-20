# ADR 0029 — Novo ticket pela conversa com a IA: Claude, Jev, mapa dos ramos e memória

**Status:** Aceita para o fluxo de criação. A reclassificação ao editar (IDEA-014) fica fora, à espera de medição. **Data:** 2026-11-20.

## Contexto

Teodoro pediu em 2026-11-19 (IDEA-005): um botão de novo ticket abre um painel lateral com uma conversa com a IA da plataforma; a IA faz perguntas e formata o texto antes de procurar, do topo até a base da árvore, o ramo em que a demanda se enquadra como folha; a IA tem memória e um mapa mental de qual ticket está onde e sobre qual conteúdo.

Em 2026-11-20 ele decidiu antecipar isso para logo depois da página do ticket (dúvida 11 do blueprint) e respondeu às dúvidas 5 e 10:

- **Provedores autorizados:** Claude, da Anthropic, para a conversa e o texto; Jev, da TypeSafe, para escolher o ramo. O texto dos tickets do projeto e o que a pessoa escreve na conversa saem para esses dois provedores.
- **Modelo da conversa:** Claude Opus 5.5.
- **Memória:** o resumo do que cada ramo cobre, atualizado quando o ramo muda, e as conversas de criação, guardadas por pessoa e projeto e apagáveis pela própria pessoa.
- **Chaves:** ficam com a coordenação operacional. Nas palavras dele: "O grok faz essas coisas, mas no .env já tem a chave da anthropic e do jev".

Fatos conferidos na documentação em 2026-11-20:

- Claude Opus 5.5 (`claude-opus-5-5`): o raciocínio não pode ser desligado, o esforço padrão é `medium` e deve ser informado, e forçar a chamada de uma ferramenta devolve erro. Saída estruturada é o caminho para receber dados.
- Jev (`jev-1.14.0`): responde perguntas tipadas sobre um estado. `Choice` sempre escolhe uma opção, mesmo quando nenhuma serve; `Noul` dá a probabilidade de uma afirmação. Limite de 32 mil tokens por pergunta e 64 mil por requisição. Cobra só a entrada. Não treina com dados de clientes.
- O limite de 5 segundos da transação do Prisma já derrubou uma importação neste projeto. Uma chamada a um modelo demora mais que isso.

## Decisão

### Fronteiras

- Os provedores são chamados só por `apps/api`. As chaves nunca chegam à web.
- **Claude conversa e escreve; Jev julga; o código decide.** Nenhuma resposta de modelo cria, move ou altera ticket. Toda escrita é uma operação de domínio com as validações de sempre, depois de a pessoa confirmar.
- O modelo não recebe ferramentas. Texto de ticket e de conversa é dado, nunca instrução.
- A criação manual da [ADR 0026](0026-pagina-do-ticket-e-zoom-ate-a-folha.md) continua disponível e é o caminho quando a IA falha.

### Configuração

`ANTHROPIC_API_KEY` e `TYPESAFE_API_KEY` entram na configuração da API como opcionais. Sem as duas, a IA fica desligada: `GET /api/me` informa `assistant.enabled: false`, a web não mostra o botão, e as rotas que chamam um provedor respondem 503 `assistant_not_configured`. Ler, ajustar o rascunho e apagar as próprias conversas continua funcionando sem as chaves, para a pessoa não perder o acesso aos seus dados. A API não sobe em erro por falta delas.

### Chamada a provedor fora de transação

A [ADR 0021](0021-neon-postgres-e-rls-por-organizacao.md) põe cada requisição em uma transação. As rotas da IA seguem outra forma, a mesma que a consulta ao Clerk já usa:

1. transação curta de leitura: permissão, projeto, conversa e o trecho da árvore necessário;
2. chamada ao provedor, sem transação aberta;
3. transação curta de escrita, que **confere de novo** o que a leitura viu (permissão, projeto não arquivado, conversa ainda aberta, pai existente) antes de gravar.

O contexto de tenant e a RLS valem nas duas transações. Nenhuma outra rota muda.

### A conversa (Claude)

- **Modelo:** `claude-opus-5-5`, API de mensagens, esforço `medium`, com o recurso de alternativa em caso de recusa do provedor ligado. Sem agente e sem ferramentas: é um passo de fluxo controlado pelo código.
- **Cada turno devolve dados estruturados:** a mensagem para a pessoa, o rascunho (`title`, `description`) quando já houver um, e se a IA considera o rascunho pronto para procurar o lugar.
- A IA pergunta só o que falta para alguém executar o ticket e para situá-lo na árvore. A pessoa pode editar o rascunho à mão a qualquer momento e pode pedir a procura do lugar mesmo que a IA ainda queira perguntar.
- A resposta chega inteira ao navegador (sem transmissão parcial) neste recorte.

### O mapa dos ramos

Cada ticket com filhos tem um **resumo do que o ramo cobre**, de até 600 caracteres, escrito pelo mesmo Claude Opus 5.5 com esforço `low` a partir do título, do trecho da descrição e dos títulos e resumos dos filhos.

- O resumo é guardado com uma marca do conteúdo de que saiu. Quando o ramo muda, a marca deixa de bater e o resumo é refeito na próxima vez em que for necessário. Não há tarefa em segundo plano.
- Na primeira procura em um projeto, os resumos que faltam nos ramos visitados são escritos na hora, em paralelo (até 8 por nível); por isso ela é mais lenta que as seguintes.
- O resumo de um ramo usa os resumos dos filhos que já existem. Quando a procura desce e escreve os resumos de um nível mais fundo, o resumo do pai é refeito na procura seguinte; o mapa se estabiliza em até três procuras. É um custo extra pequeno, aceito para não escrever a árvore inteira de uma vez.
- Um resumo que passe de 600 caracteres derruba a procura com `assistant_unavailable`; o pedido ao modelo é de até 500, para dar margem. Se a rodada com os provedores reais mostrar que isso acontece, entra uma segunda tentativa.

### A procura do caminho (Jev)

Começa na raiz do projeto e desce um nível por vez. Em cada nível, os **candidatos** são os filhos que já têm filhos (os ramos); ticket folha não é candidato. O ticket novo entra como filho do ramo mais fundo que servir.

Substituído pela [ADR 0030](0030-ticket-folha-como-candidato-na-procura-do-caminho.md): todo filho direto é candidato, com ou sem filhos, e o texto das duas perguntas abaixo foi revisto lá. Depois, pela [ADR 0031](0031-agrupadores.md): os candidatos são os agrupadores filhos, e a seleção de um agrupador define o escopo da procura.

Em cada nível, uma requisição com o rascunho, o ramo atual e os candidatos (título e resumo de cada um), e duas perguntas:

- `Noul`: o rascunho descreve um trabalho que pertence a algum dos ramos candidatos?
- `Choice`: qual ramo candidato cobre o trabalho descrito no rascunho?

O código lê as respostas assim (limiares iniciais, a calibrar com casos reais):

| `Noul` "pertence a algum" | Resultado no nível |
| --- | --- |
| abaixo de 0,3, ou não há candidatos | para aqui: o ticket fica como filho do ramo atual (na raiz, vira ticket de raiz) |
| entre 0,3 e 0,7 | mantém as duas hipóteses: parar aqui e descer no ramo mais provável |
| acima de 0,7 | desce nos ramos mais prováveis |

- A descida mantém até **3 caminhos** em paralelo e os ordena pela média geométrica das probabilidades do `Choice` ao longo do caminho, como no guia de classificação hierárquica da TypeSafe.
- O resultado traz o destino, até 2 alternativas e os ramos descartados em cada nível. Quando o primeiro caminho não se destaca do segundo, o resultado vem marcado como **incerto** e a web pede que a pessoa escolha. Na implementação, "não se destaca" é a nota do primeiro ser menos de 1,25 vez a do segundo. Além disso, quando os dois primeiros são "parar aqui" e "descer" do mesmo ramo, na faixa do meio, o resultado é sempre incerto: a nota do `Choice` não mede um contra o outro.
- Na faixa do meio a descida segue só o ramo mais provável; acima de 0,7 segue os 3 mais prováveis.
- As probabilidades não são mostradas como "chance de acerto".
- Se os candidatos de um nível não cabem no limite de tokens do Jev, a procura para naquele nível e diz isso. Nunca corta candidatos em silêncio. A TypeSafe não documenta como contar tokens, então o código usa uma estimativa conservadora (caracteres divididos por 3, mais 20%) contra um teto de 28 mil, abaixo dos 32 mil reais.
- Limites: 20 níveis, 3 requisições por nível.

"Parar na raiz" e "parar no primeiro nível" são resultados comuns, não exceção: a árvore real do TREEPM tem 6 raízes e quase só dois níveis.

### Dados guardados (migration 0005)

Tabelas com `org_id` e RLS, como as demais:

- **Conversas de criação:** projeto, pessoa autora, situação (aberta, ticket criado, descartada), rascunho atual, se a IA considerou o rascunho pronto no último turno, ticket criado e datas.
- **Mensagens da conversa:** autor (pessoa ou assistente), texto e data.
- **Resumos de ramo:** ticket, resumo, marca do conteúdo, modelo e data.

Regras que a RLS não cobre e que a API impõe, com teste de caso negativo:

- Só a pessoa autora lê, continua e apaga as próprias conversas. Administrador não lê conversa alheia.
- Uma conversa só usa tickets e resumos do próprio projeto, e só se a pessoa ainda vê o projeto.
- Apagar a conversa apaga as mensagens. O ticket criado permanece.

Remover um ticket remove o resumo do ramo dele.

### Rotas

Todas exigem poder criar ticket no projeto (administrador da organização, gestor ou colaborador) e projeto não arquivado.

| Rota | O que faz |
| --- | --- |
| `POST /api/projects/:projectId/ticket-conversations` | abre a conversa com a primeira mensagem e devolve o primeiro turno |
| `POST /api/ticket-conversations/:id/messages` | envia uma mensagem e devolve o turno seguinte |
| `PATCH /api/ticket-conversations/:id/draft` | a pessoa ajusta o rascunho, sem IA |
| `POST /api/ticket-conversations/:id/placement` | procura o caminho para o rascunho atual |
| `POST /api/ticket-conversations/:id/ticket` | cria o ticket no pai informado |
| `GET /api/ticket-conversations?projectId=` e `GET /api/ticket-conversations/:id` | as conversas da própria pessoa |
| `DELETE /api/ticket-conversations/:id` | apaga a conversa |

- **Criação idempotente:** cada conversa cria no máximo um ticket. Repetir a chamada devolve o ticket já criado.
- A criação grava `ticket.created` com a origem "assistente" e a conversa no evento.
- A procura e a criação exigem rascunho na conversa: sem ele, 409 `draft_required`.
- Erros novos: 503 `assistant_not_configured`; 503 `assistant_unavailable` (provedor fora do ar, lento demais, recusa sem alternativa ou resposta fora dos limites do ticket, que nunca é cortada); 409 `conversation_closed`; 409 `conversation_changed`, quando outra mensagem entrou na mesma conversa enquanto o provedor respondia.
- O ajuste manual do rascunho não muda a marca de "pronto"; ela é só a opinião da IA no último turno, e a pessoa pode pedir a procura do lugar a qualquer momento.
- Tempo máximo: 60 segundos por turno de conversa e 30 por procura.

### Web

Segue os quadros aprovados "Novo ticket 1" e "Novo ticket 2". `packages/engine` e `packages/react` não mudam.

- **Botão "Novo ticket":** flutuante, no canto inferior direito do mapa, só quando `assistant.enabled` é verdadeiro e a pessoa pode criar ticket em algum projeto não arquivado. É a ação principal do mapa.
- **Projeto da conversa:** o do ticket ou projeto selecionado; sem seleção, o único projeto em que a pessoa pode criar; havendo mais de um, o painel pede a escolha antes da primeira mensagem.
- **Painel de 440 px à direita,** no lugar da página do ticket e do painel de áreas e projetos (um de cada vez). O mapa estreita como na página do ticket.
- **Conversa:** as mensagens, o campo de texto e o rascunho (título e descrição editáveis à mão). Enquanto a IA responde, o painel mostra que está aguardando e não aceita outra mensagem. "Procurar o lugar" fica disponível assim que existe rascunho, mesmo que a IA ainda pergunte.
- **Memória visível:** ao abrir o painel em um projeto, a conversa aberta mais recente da pessoa nesse projeto continua de onde parou. "Nova conversa" começa outra; "Apagar conversa" apaga a atual, com o segundo clique no mesmo lugar.
- **Caminho encontrado:** o painel mostra o caminho do topo até a base, as alternativas e, quando for o caso, o aviso de incerto ou de parada antecipada. O mapa vai até o ramo de destino e mostra ali um **card tracejado** com o título do rascunho, que não é um ticket e não abre página. Escolher uma alternativa leva o card e a câmera para ela.
- **Ações:** "Criar aqui" cria no destino mostrado; "Um nível acima" passa o destino para o pai do atual (ou a raiz do projeto); "Escolher no mapa" faz o próximo clique em um ticket ou no projeto virar o destino. Depois de criar, o painel fecha e a página do ticket novo abre.
- **Falhas:** `assistant_unavailable` mostra a mensagem e "Tentar de novo", mantendo o texto digitado, e oferece a criação manual. `conversation_changed` recarrega a conversa.
- **Câmera ao fechar o painel sem criar:** segue a mesma preferência "Ao fechar um ticket" da [ADR 0028](0028-preferencias-por-usuario-e-pagina-de-configuracoes.md).
- A web aceita `GET /api/me` sem o campo `assistant` (API antiga) e trata como desligado.

### Privacidade e registro

- Saem para os provedores: o rascunho, as mensagens da conversa, e títulos, trechos de descrição e resumos de tickets do projeto. Não saem nomes, e-mails nem identificadores de pessoas.
- Os registros da API não guardam o texto enviado nem o recebido; guardam o modelo, a duração e o resultado.
- Cada resposta guardada leva o modelo que a produziu.

### Verificação com os provedores de verdade

Os testes automáticos usam provedores falsos. Antes de a web ser construída em cima, há uma rodada com os provedores reais, disparada por Teodoro, com o texto enviado e um teto de gasto informados antes. A latência do banco já escondeu um defeito atrás de testes locais uma vez.

**Rodada de 2026-11-20,** feita por Teodoro com `apps/api/scripts/verify-providers.ts` e texto fictício fixo, uma chamada de cada:

| Chamada | Duração | Tokens | Resultado |
| --- | --- | --- | --- |
| Turno de conversa (Claude Opus 5.5, esforço `medium`) | 5,8 s | 66 de entrada, 1.324 gravados em cache, 427 de saída | rascunho com título, contexto, resultado esperado e critérios de aceite; marcado como pronto, com duas perguntas opcionais |
| Resumo de ramo (Claude Opus 5.5, esforço `low`) | 2,7 s | 110 de entrada, 592 gravados em cache, 88 de saída | resumo de duas frases, dentro do limite |
| Escolha do ramo (Jev `jev-1.14.0`, três ramos) | 0,25 s | 669 de entrada | "pertence a algum" 0,98; ramo certo com 1,0 |

Pelos preços da data, a rodada custou cerca de US$ 0,02. É uma medição única com um caso fácil: confirma que as chamadas, as chaves e a saída estruturada funcionam, não que os limiares estejam calibrados. No rascunho, o critério "o comportamento em outros dispositivos continua funcionando" não veio da pessoa; é o tipo de acréscimo a observar em casos reais.

## Fora desta ADR

- **Reclassificação ao editar (IDEA-014).** Teodoro decidiu que a mudança é confirmada ao salvar e que, quando realmente fizer sentido, o ticket não é salvo sem mudar de lugar. O critério do "realmente faz sentido" e o que acontece quando ele erra e a pessoa fica sem conseguir salvar dependem de medição com edições reais do TREEPM e de uma decisão dele.
- Criar categoria intermediária, detectar duplicatas, sugerir pessoas, busca semântica.
- Transmissão parcial da resposta.

## Consequências

- O TreePM passa a depender de dois provedores pagos para esse fluxo, e a ter um modo sem eles.
- Texto de tickets e de conversas sai da plataforma. É a primeira vez; fica restrito ao projeto que a pessoa vê.
- O custo é por uso: um turno de conversa e cada resumo de ramo no Claude Opus 5.5 (US$ 4 por milhão de tokens de entrada e US$ 20 de saída) e as perguntas ao Jev (US$ 0,042 por milhão de tokens de entrada).
- A API ganha rotas que não cabem em uma transação só. A regra de conferir de novo na escrita vira parte do padrão.
- A migration 0005 precisa estar no Neon antes de o servidor local receber o código que a usa. Ela exige PostgreSQL 15 ou mais novo.
- Os limiares de 0,3 e 0,7 e a regra de "incerto" são ponto de partida; a calibração com casos reais é trabalho posterior.
