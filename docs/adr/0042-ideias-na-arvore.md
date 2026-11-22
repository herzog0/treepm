# ADR 0042 — Ideias na árvore: ticket que ainda não entrou no processo

**Status:** Aprovada por Teodoro em 2026-11-22 ("tá aprovado, se é só a cor dos cards"), depois de a coordenação esclarecer que o mapa não muda em nada além da cor dos nós de ideia. Ele não escolheu entre as duas cores nem respondeu às perguntas de "Em aberto": vale a proposta da coordenação em cada uma (rosa `#e879c6` e os padrões descritos abaixo), até ele dizer o contrário. Os quadros esquemáticos do artefato não representam o mapa e não são referência de desenho. **Data:** 2026-11-22.

## Contexto

O que Teodoro pediu, com as palavras dele:

- uma **skill "ideia"**;
- uma **nova cor de ticket**, para o que "entra como uma ideia e passa por ciclo de refinamento e triagem";
- ideias **dentro da árvore**, "como qualquer outro ticket";
- a cor diferente **da subárvore toda** deixa claro que aquilo "ainda não é parte integral do processo de desenvolvimento".

O que existe hoje, conferido no código em 2026-11-22:

- **A cor do nó é a situação** ([ADR 0025](0025-base-visual-constelacao-e-tema-do-mapa.md)): cinza para "a fazer" e "cancelado", azul para "em andamento", âmbar para "em revisão", verde para "concluído"; organização e projeto em lilás. O ticket com filhos é pintado com a mistura das cores das folhas abaixo dele. No nível de ponto, a cor é o único sinal.
- **Regras que olham os filhos de um ticket** ([ADR 0034](0034-um-so-tipo-de-ticket-das-folhas-para-o-topo.md)): concluir é recusado com filho aberto; um ticket aberto que entra num pai concluído reabre o pai; o progresso do pai conta os descendentes; o "ticket da vez" é o pai cujos filhos terminaram.
- A ADR 0034 acabou com os tipos de ticket. Uma ideia não pode voltar a ser um tipo.
- **`docs/ideas.yaml`** guarda 20 ideias do próprio TreePM (15 propostas, 5 já implementadas), fora do produto.
- A coordenação cria tickets pela ferramenta de linha de comando, que não sabe criar uma ideia.

A pergunta que decide o desenho: uma ideia colocada dentro de um ticket concluído reabre o pai? Impede concluir? Entra no progresso? Mancha a cor do ramo? Se a resposta de todas for "não", e é o que "ainda não é parte do processo" pede, a ideia **não pode ser mais uma situação**: situação é exatamente o que essas regras leem.

## Decisão

### Ideia é um estágio do ticket, separado da situação

Todo ticket ganha um campo opcional, o **estágio de ideia**. Vazio, o ticket é como hoje. Preenchido, o ticket é a **raiz de uma ideia**.

| Estágio | Quer dizer |
| --- | --- |
| Nova | Alguém registrou; ninguém olhou ainda |
| Em refinamento | Está sendo detalhada: descrição, filhos, áreas, conversa |
| Pronta para triagem | Quem refinou acha que dá para decidir |
| Descartada | A triagem decidiu não fazer; fica no lugar, como registro |

Não é um tipo: é o mesmo ticket, com a mesma página, descrição, filhos, áreas, comentários e histórico. O que muda é em que ponto do caminho ele está.

### A subárvore inteira é a ideia

- O estágio fica **só na raiz** da ideia. Tudo o que está embaixo dela **faz parte da ideia** por estar ali, sem campo próprio.
- **Mover** um ticket para dentro de uma ideia o torna parte dela; mover para fora o devolve ao processo.
- Uma ideia pode ter outra ideia dentro (uma variação com triagem própria). Aceitar a de fora não aceita a de dentro.
- Quem quer levar adiante **só uma parte** move essa parte para fora da ideia.

### Fora do processo: o que cada regra faz

O caso que guiou a decisão: uma ideia registrada dentro de um ticket concluído.

| Regra de hoje | Com uma ideia (raiz ou qualquer ticket dentro dela) |
| --- | --- |
| Ticket aberto que entra num pai concluído reabre o pai | **Não reabre.** |
| Concluir é recusado com filho aberto | **A ideia não conta** como filho aberto. |
| Progresso do pai | **Fora da conta**, nem no total nem nos excluídos. O pai mostra à parte "n ideias". |
| Cor do pai, pela mistura das folhas | **A ideia não entra na mistura.** O ramo de fora continua mostrando só o que é trabalho. |
| Ticket da vez | **Nunca** é uma ideia nem um ticket dentro de uma. |
| Situação | Dentro de uma ideia a situação fica parada em "a fazer" e não pode ser mudada: quem quer trabalhar nela aceita antes. |

### Triagem

- **Aceitar** tira o estágio: a raiz e tudo embaixo dela passam a ser tickets comuns, no mesmo lugar da árvore, na situação "a fazer". Nesse momento valem as regras de sempre: se o pai estava concluído, ele é reaberto, com a entrada automática no histórico.
- **Descartar** põe o estágio "Descartada": a subárvore continua fora do processo, desenhada mais apagada. Pode ser reaberta como ideia (volta para "Em refinamento") ou excluída como qualquer ticket.
- Ideia aceita **não volta** a ser ideia; se a decisão mudar, cancela-se o ticket.

### Quem faz o quê *(escolha da coordenação)*

- **Registrar** uma ideia e **refinar** (mudar o estágio entre Nova, Em refinamento e Pronta para triagem; editar tudo dentro dela): quem pode criar e editar tickets no projeto.
- **Aceitar e descartar:** gestor do projeto.
- Projeto arquivado: só leitura, como hoje.

### Como fica no mapa

A [ADR 0025](0025-base-visual-constelacao-e-tema-do-mapa.md) diz "cor do nó = situação". Esta ADR acrescenta: **dentro de uma ideia, a cor do nó é a cor de ideia**, qualquer que seja a situação.

- Uma cor só para a subárvore inteira, da raiz às folhas, em todos os níveis de detalhe. No nível de ponto ela é o único sinal, como hoje.
- A raiz da ideia leva, no lugar do marcador de situação, um marcador próprio com o estágio escrito ("Ideia · Em refinamento").
- A ideia descartada usa a mesma cor, apagada.
- O card tracejado do rascunho da conversa com a IA continua como é: a ideia tem borda cheia.
- A cor precisa se distinguir das cinco que existem. Proposta: **rosa `#e879c6`**; a alternativa nos quadros é **turquesa `#3fd0c9`**. O cinza não serve (já quer dizer "a fazer" e "cancelado"), o lilás é a organização e o projeto, e laranja e vermelho leem como alerta.

**O mapa não muda em mais nada:** layout, cards, níveis de detalhe, zoom e interação ficam como estão (aprovados em 2026-11-19). Um esquema com as duas cores, que não reproduz o mapa: **[TreePM — ideias no mapa](https://claude.ai/artifact/BZnrDWhxWRQjZaGEDnnvjd)** (privado).

### Na página do ticket

- **Raiz de ideia:** a linha "Situação" dá lugar a "Ideia", com o estágio num menu e, para o gestor, "Aceitar" e "Descartar" (com confirmação que diz o que acontece com a subárvore).
- **Ticket dentro de uma ideia:** a linha "Situação" mostra "Parte da ideia TREEPM-n", com o link para a raiz.
- "Novo ticket aqui dentro" ganha ao lado "Nova ideia aqui dentro".
- Um ticket comum, aberto e sem filhos concluídos, pode ser **transformado em ideia** pelo menu "Mais ações" (para o que foi registrado como ticket antes de a ideia existir). Ticket em andamento ou concluído, não.
- O histórico ganha as entradas: registrada como ideia, estágio alterado, aceita, descartada, reaberta.

### Onde se registra e onde se faz a triagem

- **Barra de pedidos:** com texto digitado, a linha "Registrar ideia «texto»", ao lado de "Criar ticket «texto»". Cria a ideia no estágio "Nova" e abre a página dela. O lugar na árvore é o ticket selecionado no mapa, ou a raiz do projeto.
- **Tela "Ideias"** do projeto: a lista das ideias por estágio, da mais antiga para a mais nova, com o caminho na árvore. É onde a triagem acontece: abrir, aceitar, descartar. Clicar em "ver no mapa" leva a câmera até a ideia.

### A skill `/ideia`

Uma skill do Claude Code, guardada no repositório (`.claude/skills/ideia/`), para qualquer sessão de agente neste projeto, inclusive a coordenação:

- `/ideia <texto livre>`: escreve título e descrição a partir do texto, escolhe o lugar na árvore do projeto `TREEPM` (lê a árvore com a ferramenta de tickets e diz onde pôs e por quê) e cria a ideia no estágio "Nova". Responde com a chave e o caminho.
- `/ideia refinar TREEPM-n`: conversa sobre a ideia, reescreve a descrição, propõe filhos e áreas e, com o sim da pessoa, passa o estágio para "Em refinamento" ou "Pronta para triagem".
- A skill **não aceita nem descarta**: triagem é de Teodoro.
- Depende de a ferramenta de linha de comando saber criar uma ideia e mudar o estágio (`ticket-create --idea`, `ticket-update --idea-stage`), que é trabalho de executor.

### IA e MCP *(decisões de Teodoro; a proposta é o padrão mais conservador)*

- **Pergunta sobre o projeto e MCP:** o resumo do projeto conta as ideias à parte, e cada ticket lido diz se é ideia ou parte de uma. Assim "o que falta fazer?" não lista ideias como trabalho pendente. O texto das ideias é texto de ticket, que já vai à IA hoje.
- **Procura do lugar para um ticket novo:** uma ideia e o que está dentro dela **não são candidatos**: trabalho novo não cai dentro de uma ideia por decisão da IA. Uma ideia nova é colocada por quem a registra.

### `docs/ideas.yaml`

Depois que as ideias existirem no produto, as 15 propostas do arquivo viram ideias no projeto `TREEPM`, cada uma no lugar da árvore que lhe couber, e as 5 implementadas ficam de fora. O arquivo só é removido, e a menção a ele no `AGENTS.md` trocada, com o sim de Teodoro. É uma fatia própria.

### Banco

Uma coluna opcional em `tickets` para o estágio, com as quatro opções. Nenhuma tabela nova. Migration própria, numerada quando a implementação começar.

## Fatias

1. **Regras:** o campo, as rotas de registrar, mudar estágio, aceitar e descartar, e as cinco regras da tabela "Fora do processo", cada uma com teste. Histórico.
2. **Mapa e página do ticket:** a cor, o marcador, a linha "Ideia".
3. **Barra de pedidos e tela "Ideias".**
4. **Ferramenta de linha de comando e a skill `/ideia`.**
5. **IA e MCP** contam ideias à parte e a procura deixa de considerá-las.
6. **`docs/ideas.yaml`** vira ideias no projeto.

## Alternativas descartadas

- **"Ideia" como mais uma situação.** A cor sairia de graça, mas toda regra que lê situação passaria a tratar a ideia como trabalho aberto: reabriria pais, travaria conclusões e entraria no progresso. É o contrário do que foi pedido.
- **Estágio em cada ticket da subárvore.** Mover um ticket exigiria reescrever o ramo inteiro, e dois tickets do mesmo ramo poderiam discordar.
- **Ideias fora da árvore, numa lista separada.** É o que `docs/ideas.yaml` faz hoje, e Teodoro pediu o contrário: a ideia já nasce no lugar onde viraria trabalho.
- **Um projeto só de ideias.** Tira a ideia de perto do trabalho com que ela se relaciona.

## Em aberto, para Teodoro

1. **A cor:** rosa ou turquesa (ou outra), olhando os quadros.
2. **Os estágios:** os quatro propostos bastam? Os nomes servem?
3. **Quem registra:** só quem cria tickets, ou qualquer pessoa que enxerga o projeto, inclusive leitor?
4. **Quem faz a triagem:** só o gestor do projeto?
5. **A situação congelada** dentro de uma ideia: está certo, ou filhos de uma ideia podem andar antes do aceite?
6. **IA:** as ideias aparecem na pergunta sobre o projeto e no MCP marcadas como ideias, como proposto?
7. **`docs/ideas.yaml`:** migrar e remover o arquivo?

## Como ficaram as fatias 1 e 2 (PRs #136 e #137, 2026-11-22)

- **Banco:** `tickets.idea_stage` (migration `0018`), com check das quatro opções, check de que estágio preenchido exige situação `a fazer`, e índice parcial para listar as ideias de um projeto.
- **Domínio:** `ideaRootOf` e as cinco regras de "Fora do processo" como funções puras. O "ticket da vez" só existe no domínio; a API não o calcula.
- **Rotas:** criar ticket com `idea: true`; `PUT /api/tickets/:id/idea-stage`; `POST /api/tickets/:id/idea/accept` e `/discard` (gestor); `POST /api/tickets/:id/idea` (transformar em ideia); `GET /api/projects/:projectId/ideas`. Códigos de recusa: `ticket_in_idea`, `ticket_not_idea_root`, `idea_stage_transition`, `idea_discarded`, `ticket_already_idea`, `idea_has_work` e `move_into_idea_blocked`.
- **Leitura:** resumo e detalhe trazem `idea` (`null`, `{ root: true, stage }` ou `{ root: false, rootId, rootKey }`); `progress` ganhou `ideas`, que conta todas as raízes de ideia abaixo do ticket, em qualquer nível; o detalhe traz `canTriageIdea`.
- **Cancelado:** um descendente cancelado continua cancelado ao virar parte de uma ideia e depois do aceite. Diferente do que a seção "Triagem" dizia ("todos a fazer"): o aceite não mexe em situação nenhuma.
- **Mover para dentro de uma ideia** só é aceito se o ticket e os descendentes estiverem `a fazer` ou cancelados. A subárvore não é travada durante essa conferência; é um risco residual pequeno, conhecido.
- **Registrar** uma ideia grava dois eventos (ticket criado e ideia registrada), e o histórico mostra as duas entradas.
- **Camada de consulta e MCP:** aceitam o número `ideas` no progresso e o calculam como a API de tickets. Nada mais mudou para a IA: as ideias ainda aparecem para ela como tickets `a fazer` no resumo por situação, e a procura ainda as considera candidatas. Isso é a fatia 5 (`TREEPM-108`).
- **Mapa:** a cor é aplicada em `buildMapItems` e a mistura em `paintBranches` (`apps/web/src/map/items.ts`). Ideia descartada usa a cor de ideia misturada meio a meio com o fundo. Um teste de instantâneo, gravado no código de antes, garante que uma árvore sem ideias é desenhada igual. O texto "Ideia · estágio" aparece no nível de detalhe "completo"; chip e compacto mostram só o quadrado, como já era.
- **Página do ticket:** "Mais ações" passou a aparecer também para colaborador, por causa de "Transformar em ideia"; "Remover ticket" continua só para quem já podia.
- **Linha de comando:** `ticket-create --idea` e `ticket-update --idea-stage`; `ticket-list` marca a raiz e os tickets de dentro. Aceitar e descartar ficaram fora, de propósito.
- **As ideias de `docs/ideas.yaml`** foram levadas ao projeto `TREEPM` em 2026-11-22 (`TREEPM-110` a `TREEPM-176`): dez ideias com 57 subitens. Dez entradas do arquivo já estavam implementadas e duas já eram tickets; ficaram de fora. O arquivo não foi alterado (`TREEPM-177`).
- **Não foi exercitado** com sessão real no navegador (`TREEPM-179`).
