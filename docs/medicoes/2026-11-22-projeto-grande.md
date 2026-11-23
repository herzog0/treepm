# Medição da plataforma com um projeto grande (2026-11-22, TREEPM-191)

Teodoro quer o TreePM "usado por muita gente em projetos pesados", e até aqui ninguém tinha medido nada com um projeto grande. Este documento traz números e gargalos, **sem nenhuma correção**: nenhum código de produto foi alterado, e o que se mediu é o que está no `main` (`46efdce`). A ferramenta de medição ficou no repositório; o relatório diz como rodá-la de novo.

## Como reproduzir

```
export TEST_DATABASE_MIGRATION_URL=postgresql://treepm_owner:…@127.0.0.1:54329/treepm_p1   # banco só de medição
export TEST_DATABASE_URL=postgresql://treepm_app:…@127.0.0.1:54329/treepm_p1
pnpm --filter @treepm/api big-project:generate --n 5000 [--seed 7] [--setup-db]   # só gera o projeto
pnpm --filter @treepm/api measure:big-project [--sizes 1000,5000,20000] [--reps 5] [--setup-db]   # API (gera, mede, grava as respostas)
pnpm --filter @treepm/web measure:big-project            # web em Node, sobre as respostas gravadas
pnpm --filter @treepm/web measure:big-project:browser    # mapa em Chrome headless
```

Saída em `.measure/big-project/` (fora do Git): `results-N.json`, `explain-N.txt`, `web-node-N.json`, `web-browser-N.json`. As ferramentas recusam rodar sem as duas variáveis e em banco que não seja `treepm_p<N>`/`treepm_test` (o gerador apaga todas as organizações do banco). Medir as três escalas leva cerca de 4 minutos.

**O gerador** (`apps/api/scripts/big-project/plan.ts`, parte pura com semente; `load.ts`, gravação) grava por **SQL em lote pelo papel dono**, não pelos serviços: `POST …/tickets/import` aceita no máximo 500 itens e não cria ideias, marcadores de trabalho pela IA, comentários, contribuições nem histórico, e criar 20 000 tickets um a um custaria várias idas ao banco por ticket e a trava da linha do projeto a cada criação. Em troca, o carregamento não passa pelas regras dos serviços; por isso o plano as respeita (nada concluído com filho aberto; ideia e o que está dentro dela em "a fazer" e sem marcador; marcador com os quatro campos) e o teste `big-project-load.test.ts` confere a carga contra a API de verdade (a lista passa na validação de saída, o detalhe e a atividade respondem, e `POST …/mentions/rebuild` devolve `created: 0, removed: 0`, isto é, as ligações gravadas são exatamente as que a regra do produto faria). Árvore por ligação preferencial (larguras muito variadas, até 60 filhos), profundidade até 7, ~15% concluídos em ramos inteiros, ~1,2% de raízes de ideia, ~0,4% de marcadores de IA, descrições de 0 a 19 000 caracteres (média 1 285; 20% vazias), menções em ~14%, 30% com responsáveis, comentários em ~9%, contribuições em ~7%, histórico em ~35%, além de um ticket de muito histórico (1 500 eventos, 400 comentários). Mesma semente, mesmo projeto (ids inclusive).

| | N = 1 000 | N = 5 000 | N = 20 000 |
|---|---|---|---|
| Tickets por profundidade 1…7 | 11, 64, 193, 228, 173, 189, 142 | 30, 115, 398, 732, 1 100, 1 215, 1 410 | 95, 247, 995, 2 390, 4 149, 5 506, 6 618 |
| Concluídos | 152 | 751 | 3 000 |
| Eventos / comentários / contribuições / ligações | 3 420 / 633 / 154 / 172 | 10 745 / 1 573 / 701 / 805 | 38 944 / 4 925 / 2 740 / 3 094 |
| Tamanho no banco (tickets + eventos) | ~1 MB + 1,6 MB | ~4,5 MB + 4,5 MB | 17 MB + 15 MB |
| Gravação do projeto | 0,4 s | 1,2 s | 4,3 s |

## Onde e com que carga

Notebook de desenvolvimento: Intel Core i5-11400H (6 núcleos, 12 threads), 31 GB, Linux 7.0, Node 22.23.1, PostgreSQL 17.12 em contêiner Docker na mesma máquina (o banco é local: não há latência de rede; em produção cada uma das 9 a 41 consultas por requisição soma ida e volta). Os outros painéis do herdr rodavam suítes ao mesmo tempo, então a carga nunca foi zero. Carga média (1/5/15 min) no início e no fim de cada bateria:

| Bateria | Início | Fim |
|---|---|---|
| API, bateria final (N = 1 000, 5 000, 20 000) | 2,87 / 5,20 / 12,39 | 2,88 / 4,52 / 11,27 |
| Web em Node | 2,88 / 4,52 / 11,27 | 4,03 / 4,67 / 11,21 |
| Web em navegador | 4,03 / 4,67 / 11,21 | 4,13 / 4,60 / 10,55 |
| API, primeira bateria completa (descartada, mesma máquina mais ocupada) | 4,47 / 6,35 / 15,11 | 9,69 / 7,63 / 14,79 |

Efeito da carga: na primeira bateria, com carga de 4,5 a 9,7, a lista de 20 000 tickets levou 1 237 ms (pior 1 735) e a busca do MCP 924 ms; na final, com ~3, 699 ms e 536 ms. Leia os números abaixo como "ordem de grandeza com ±40%". Cada operação: 1 aquecimento descartado e 5 repetições (mediana / pior). O navegador é o Chrome 1440×900 headless da suíte de navegador, sem GPU dedicada.

## API (pelo caminho HTTP de verdade, aplicação Nest de teste, usuário falso, administrador da organização)

Mediana / pior caso em ms, bytes do corpo cru (sem compressão), consultas ao banco por requisição (sem BEGIN/COMMIT/`set_config`) e a soma do tempo dessas consultas no cliente `pg` (dbMs; consultas em paralelo somam acima do relógio).

| Operação | N = 1 000 | N = 5 000 | N = 20 000 |
|---|---|---|---|
| **Lista de tickets do projeto** (a do mapa) | 43,5 / 48,1 · 659 KB · 9 q · db 15 | 177 / 188 · 3,2 MB · 9 q · db 58 | **699 / 721 · 13,2 MB · 10 q · db 221** |
| Carga do mapa (projetos + pessoas, depois a lista) | 52 / 55 · 662 KB | 174 / 176 · 3,2 MB | 765 / 772 · 13,2 MB |
| Refresh a cada 30 s (`useAutoRefresh`: a mesma carga) | 51 / 54 · 662 KB | 179 / 193 · 3,2 MB | 752 / 777 · 13,2 MB |
| Detalhe de ticket raso (raiz) | 16,5 / 18,9 · 8,8 KB · 20 q | 31 / 33 · 6,6 KB | 97 / 100 · 11,9 KB · db 26 |
| Detalhe de ticket fundo (profundidade 7) | 16,3 / 22,4 · 4,8 KB | 29 / 32 · 9,4 KB | 99 / 107 · 17,5 KB · db 35 |
| Atividade do ticket de muito histórico (30 entradas) | 15,3 / 16,7 · 9 KB · 14 q | 10,4 / 12,7 | 10,0 / 12,1 · 9,7 KB |
| Atividade, página de 100 | 20,7 / 22,4 · 32 KB | 15,2 / 18,0 | 15,3 / 17,2 · 32 KB |
| Atividade, última página (25ª de 100) | 11,0 / 12,6 | 7,2 / 8,6 | 7,9 / 11,0 |
| Tela Ideias | 8,7 / 10,1 · 4,3 KB · 9 q | 14,6 / 18,4 · 24 KB | 37,8 / 39,4 · 101 KB |
| Situação de folha funda **com propagação** (reabre 6 pais) | 30,6 / 42,5 · 41 q | 41,6 / 42,8 | 104 / 108 · db 31 |
| Situação de folha funda sem propagação | 35,8 / 44,6 · 24 q | 32,3 / 36,8 | 99 / 104 · db 29 |
| Mover ticket de pai (A→B→A) | 32,4 / 42,5 · 24 q | 36,7 / 39,7 | 130 / 162 · db 69 |
| MCP `list_tickets` (50, 1ª página) | 26,3 / 29,7 · 44 KB · 14 q | 31,2 / 31,9 | 94 / 106 · 44 KB |
| MCP `list_tickets` (200, 1ª página) | 27,4 / 42,8 · 168 KB | 35,7 / 36,5 | 102 / 112 · 169 KB |
| MCP `get_ticket` (fundo) | 31,8 / 39,6 · 24 q | 34,4 / 36,9 | 97,5 / 105 |
| MCP `get_project_overview` | 21,0 / 24,5 · 11 KB | 43,6 / 49,6 · 27 KB | 150 / 159 · 87 KB |
| MCP `search_tickets` ("relatórios") | 40,1 / 45,4 | 143 / 149 | **536 / 540** |
| MCP, enumerar o projeto de 200 em 200 | 144 ms (5 chamadas, 921 KB) | 1 046 ms (25 chamadas, 4,5 MB) | **11 427 ms** (100 chamadas, 17,9 MB; 1 604 consultas) |

A busca da barra de pedidos **não passa pela API**: roda no navegador sobre a lista já carregada (`apps/web/src/command/search.ts`, regra em `packages/domain/src/search.ts`); está na seção da web. A API tem a mesma regra só no MCP (`search_tickets`, acima).

**Consultas por requisição: não há N+1.** O número de consultas é o mesmo nas três escalas, linha a linha (lista 9 a 10, detalhe 20, atividade 13 a 14, propagação 41, mover 24, MCP 14 a 24). O que cresce com N é o trabalho por consulta e, sobretudo, o trabalho em Node depois dela.

**O limite do MCP é o primeiro teto real de quem enumera.** Com os limites zerados a cada 20 chamadas (para medir a vazão), enumerar 20 000 tickets levou 11,4 s. Sem zerar, o limite por token (60 por minuto, `RATE_LIMIT_PER_WINDOW`) recusa com 429 (`rate_limited`) a partir da 61ª chamada: na primeira bateria isso apareceu como falha na chamada 61 das 100 necessárias. Um cliente MCP que quiser o projeto inteiro precisa de ao menos 2 minutos e de paciência com o `Retry-After`.

### EXPLAIN (ANALYZE, BUFFERS) das três mais lentas (N = 20 000, como `treepm_app`, com o isolamento por organização)

Texto completo em `.measure/big-project/explain-20000.txt`. Em todas, **o banco não é o gargalo**.

| Operação (mediana) | Consulta principal | Tempo de execução no banco | Tempo medido pelo cliente `pg` |
|---|---|---|---|
| Lista de tickets (699 ms) | `select` de 20 000 linhas de `tickets` por `tickets_org_id_project_id_number_key` (Index Scan, 3 124 buffers) | 7,0 ms | ~120 ms (transferir e montar 20 000 linhas de ~600 bytes) |
| | `ticket_assignees … where (org_id, ticket_id) IN (…)`, 2 consultas de ~16 000 parâmetros cada | 2,8 e 2,7 ms (Seq Scan, 86 buffers), **planejamento 33 e 27 ms** | ~70 ms cada |
| `search_tickets` do MCP (536 ms) | `select` das 20 000 linhas com descrição inteira; outro `select` de todas as linhas só para as ideias (Seq Scan) | 6,4 e 6,7 ms | 165 e 42 ms |
| `get_project_overview` (150 ms) | dois Seq Scan em `tickets` do projeto inteiro | 6,7 e 2,1 ms | — |

A lista é onde se vê o custo de trazer o projeto todo: SQL em 7 ms, mas **dbMs somou 221 ms** (driver e Prisma montando linhas, e duas consultas de assignees fatiadas porque o Postgres aceita no máximo 32 767 parâmetros por consulta: com 20 000 tickets o `IN (org_id, ticket_id)` passa de 40 000 parâmetros e o Prisma divide em duas; com ~33 000 tickets seriam três). Os 480 ms restantes dos 699 ms são Node.

## Web, funções puras em Node (`measure:big-project` da web), mediana / pior em ms

| | N = 1 000 | N = 5 000 | N = 20 000 |
|---|---|---|---|
| `JSON.parse` da lista | 1,0 / 2,7 | 5,1 / 6,6 | 27 / 32 |
| `listTickets` (fetch falso + JSON + validação zod; inclui projetos e pessoas) | 9,3 / 11 | 36 / 37 | 149 / 177 |
| `buildMapItems` | 3,7 / 5,5 | 22,8 / 28,7 | **154 / 179** |
| `paintBranches`, por diferença (não é exportada; mediana menos mediana) | ≈ 3,3 | ≈ 21 | **≈ 135** |
| `buildTreeIndex` | 0,9 / 1,5 | 4,4 / 5,3 | 49 / 57 |
| `buildSpatialLayout` | 6,3 / 9,4 | 19 / 20 | **108 / 174** |
| `computeMapMaxScale` (refaz índice e layout) | 3,7 / 3,8 | 22 / 24 | 157 / 195 |
| `buildSpatialScene`, 7 níveis de zoom (um quadro, sem React) | 0,05 a 0,8 | 0,08 a 1,3 | 0,09 a 2,7 (pior 4,6) |
| Busca local da barra, por tecla (qualquer consulta) | ≈ 5 | ≈ 23 | **≈ 100 / 112** |
| `mergeMapData` do refresh de 30 s (nada mudou / um título mudou) | 2,8 / 2,5 | 16,3 / 16,0 | **103 / 82** |

A cena da engine é barata em qualquer N (no máximo 173 nós e 125 grupos num quadro, a 20 000 tickets): o custo por quadro vem do React e do DOM, não da geometria. O mapa de 20 000 tickets gasta, só em CPU de dados antes de existir, cerca de 650 ms em série (JSON + zod 177 + `buildMapItems` 154 + índice 49 + layout 108 + `computeMapMaxScale` 157; o índice e o layout são feitos duas vezes), além da rede (13 MB) e da API (699 ms); as medições se sobrepõem em parte com a montagem em navegador.

## Web, mapa em Chrome headless (`measure:big-project:browser`)

Montagem do `OrganizationMap` com o `ApiClient` falso devolvendo as respostas reais (sem rede e sem API; só montagem e render). Quadro = intervalo entre `requestAnimationFrame` (16,7 ms ≈ 60 Hz).

| | N = 1 000 | N = 5 000 | N = 20 000 |
|---|---|---|---|
| Tempo até o primeiro card visível | 130 ms | 149 ms | **795 ms** (tarefas longas: 788 ms, a maior de 697 ms) |
| Maior nº de cards no DOM em um nível de zoom | 157 (de 7 na tela inicial) | 293 | 516 |
| Maior nº de elementos na cena / na página | 859 / 995 | 1 458 / 1 594 | 2 752 / 2 888 |
| Quadros de zoom com a roda (30 passos de 3 ticks): mediana / p95 / pior | 16,7 / 33,4 / 66,7 ms; 17 de 342 acima de 33 ms | 16,7 / 50 / 83 ms; 29 de 259 | **33,3 / 133 / 250 ms**; 104 de 209 acima de 33 ms, 29 acima de 100 ms |
| Quadros de arraste (40 movimentos, 3 níveis): p95 / pior | 16,7 / 16,8 | 16,8 / 16,8 | **83 a 100 / 100 a 133 ms**; 41 quadros acima de 33 ms em cada arraste |
| Tarefas longas (> 50 ms) somadas | 1 (93 ms) | 5 (398 ms) | **407 tarefas, 39 s**, a maior de 697 ms |

Nós no DOM por nível de zoom (cards / elementos na cena), N = 20 000: tela inicial 2 / 23; projeto explorado 2 / 118; depois do primeiro zoom 174 / 953; 143 / 895; 516 / 2 752 (pico); 99 / 710; 19 / 196; 9 / 124; 5 / 76; 1 / 14 no zoom máximo. O pico fica em dezenas de centenas de nós: a engine faz o corte (culling) e a agregação em grupos, e o DOM nunca passa de ~2 900 elementos nem com 20 000 tickets.

## Gargalos, em ordem de gravidade

Gravidade = quanto o usuário sente em 5 000 a 20 000 tickets × quão cedo aparece. "Custo" = o que corrigir custaria (pequeno: horas; médio: dias; grande: mais de uma semana ou decisão de produto).

1. **A lista inteira do projeto a cada abertura e a cada 30 s** (699 ms de API + 13 MB + ~480 ms de Node no cliente a 20 000; 177 ms + 3,2 MB a 5 000). `apps/web/src/map/mapData.ts` (`loadMapData`, chamado por `OrganizationMap.tsx` na carga e em `useAutoRefresh`) baixa tudo de novo e `mergeMapData` compara por `JSON.stringify` (103 ms a 20 000, na thread principal, a cada 30 s). Custo: **grande** para tirar a raiz do problema (atualização incremental por `updatedAt`/cursor, ou lista paginada por ramo, com mudança de contrato e do mapa); **pequeno a médio** para o que alivia na hora (devolver só `id`+`updatedAt` e buscar o que mudou; comprimir com gzip/brotli no servidor, hoje não há compressão; trocar o `JSON.stringify` por comparação de `updatedAt`).
2. **A lista monta tudo em Node, por linha** (`apps/api/src/tickets/tickets.controller.ts`, `list`): traz a descrição inteira (média de 1,3 KB, 25 MB a 20 000) só para cortar o trecho; `descriptionExcerpt` (`packages/domain/src/tickets.ts`) faz `Array.from(description)` da descrição inteira, medido sozinho em **200 ms** para 20 000 tickets (contra 0,8 ms de `slice`) com as descrições geradas; depois `ticketProgress` (20 ms), `ideaViews`, e a validação zod por linha (`parseOutput(ticketSummarySchema, …)`) e a serialização de 13 MB. Custo: **pequeno** (`left(description, N)` no SQL ou excerpt pré-calculado; cortar sem `Array.from`) para a parte do excerpt; **médio** para o resto (validar só em teste, não em cada linha).
3. **Relações carregadas com `IN` de dezenas de milhares de parâmetros** (`summarySelect` com `assignees`, mesmo arquivo): planejamento de 27 a 33 ms por consulta e fatiamento por limite do Postgres (2 consultas a 20 000, 3 a ~33 000, 6 a 100 000). Custo: **pequeno** (uma consulta separada por `project_id`, sem `IN`, ou `array_agg` na própria consulta de tickets).
4. **`buildMapItems`/`paintBranches` quadrático em ramos abertos** (`apps/web/src/map/items.ts`, `paintBranches`: `descendants()` refaz `flatMap` da subárvore para cada ticket com descendentes abertos): 135 ms de 154 a 20 000, 21 de 23 a 5 000. A cor de um ramo é a mistura das folhas, que cabe numa passada de baixo para cima. Custo: **pequeno** (uma passada pós-ordem com soma de pesos).
5. **Layout e índice da engine refeitos mais de uma vez** (`packages/engine/src/spatialLayout.ts`, `buildSpatialLayout`: 108 ms; `buildTreeIndex`: 49 ms; `apps/web/src/map/zoom.ts`, `computeMapMaxScale` refaz índice e layout só para achar o menor nó: 157 ms; `useSpatialCanvas` refaz os dois sempre que `items` muda, e `items` muda a cada atualização do refresh que difira). Custo: **pequeno** para não repetir (devolver a escala máxima do próprio layout); **médio** para layout incremental.
6. **Quadros de zoom e arraste a 20 000 tickets**: p95 de 133 ms no zoom e 83 a 100 ms no arraste, 39 s de tarefas longas, com o DOM em até ~2 900 elementos e a cena custando < 3 ms na engine. O custo está fora da geometria; a hipótese mais provável (não perfilada) é React/DOM: a cada quadro a cena é reconstruída (`useSpatialCanvas`, `useMemo` sobre a câmera) e os componentes de nó reconciliam centenas de elementos (`packages/react/src/SpatialCanvas.tsx`, `SpatialNode.tsx`). Em 1 000 e 5 000 tickets é fluido (p95 ≤ 50 ms). Custo: **médio a grande** (primeiro perfilar com o painel Performance do Chrome, que esta medição não substituiu; só então escolher a correção).
7. **Detalhe de ticket, mover e mudar situação leem o projeto inteiro** (`tickets.service.ts`: `detail` faz `findMany` de todos os tickets do projeto para `ticketProgress` e `ideaViews`; `updateTicket` carrega todos para a conferência de ciclo e chama `detailFor` no fim): 16 ms a 1 000, 97 a 130 ms a 20 000, em todas as escritas e em todo clique num ticket. Custo: **médio** (calcular o progresso por consulta recursiva só do ramo, ou guardar o progresso; ciclo por CTE ascendente, que o código já usa em `ideaRootFor`).
8. **Busca local da barra, por tecla** (`packages/domain/src/search.ts`, `searchTickets`): normaliza (`NFD` + regex) título e trecho de cada ticket a cada tecla: 100 ms a 20 000 (5 ms a 1 000), na thread principal, para devolver 8 itens. Custo: **pequeno** (pré-normalizar uma vez por lista; debounce) a **médio** (índice).
9. **MCP: leituras repetem o projeto inteiro** (`apps/api/src/query/project-query.service.ts`: `search` 536 ms, `overview` 150 ms, `list` 94 ms para 50 itens; a enumeração cresce quadraticamente: 42 ms por chamada a 5 000, 114 ms a 20 000) e o limite de 60 chamadas por minuto por token limita quem enumera a ~12 000 tickets por minuto. Custo: **pequeno** (contagens e ideias por `group by`, `limit` no SQL, sem ler as descrições) a **médio** (busca textual no banco).
10. **Tela Ideias lê todos os títulos do projeto** (`ideas.service.ts`, `list`: segunda consulta de todos os tickets só para montar o caminho de cada ideia): 38 ms e 101 KB a 20 000. Custo: **pequeno** (CTE ascendente só para as ideias).

Não é gargalo: atividade do ticket (10 a 15 ms em qualquer N, paginada por cursor, ~13 a 14 consultas constantes), `buildSpatialScene` por quadro (< 3 ms), consultas SQL em si (todas ≤ 7 ms de execução, planos por índice onde há filtro; Seq Scan em `tickets` só onde se lê o projeto todo, que é onde está o problema real).

## O que não consegui medir, e os limites desta medição

- **Rede, TLS, compressão e Neon**: tudo local, banco no mesmo computador. Em produção, cada consulta soma latência (a 20 000 tickets, 9 a 41 consultas por requisição) e os 13 MB da lista seguem sem compressão: nem o Nest nem o Express comprimem (`grep compression apps/api/src` não acha nada); a Fly pode comprimir no proxy, o que não verifiquei.
- **Tempo de carga completo no navegador** (rede + API + JSON + zod + `buildMapItems` + layout + render): medi as partes (API; funções puras; montagem com dados já em memória) e não o total, e somá-las (≈ 0,7 s de API + 13 MB + 0,4 s de CPU de dados + 0,8 s de montagem a 20 000) superestima porque parte se sobrepõe.
- **Custo por quadro por componente**: o relatório diz quanto o quadro custa e quantos nós há, não o que dentro do React consome (para isso, perfil do Chrome, sem janela, fora do escopo).
- **Escrita de ticket novo** (`POST …/tickets`, `import`) e ações de grupo/assistente: não pedidas. Tokens de escrita do MCP: não medidos.
- **`paintBranches`** só por diferença (função não exportada; não alterei produto).
- **Mais de uma pessoa**: tudo foi medido com uma sessão por vez; concorrência (várias pessoas no mesmo projeto, o `for update` do projeto na criação, o timeout de 5 s da transação interativa do Prisma em `withTenant`) não foi testada. Nenhuma requisição estourou o timeout em 20 000 tickets (a pior levou 1,7 s, na primeira bateria).
- **A distribuição dos dados é minha**: descrições de 1,3 KB em média, 35% com histórico, 9% com comentários. Projetos com descrições muito maiores deixam piores a lista (excerpt, 25 MB lidos) e o MCP.
- Variação entre baterias com a máquina carregada: até ±40% (ver acima). Não rodei com a máquina parada.
- Os testes `big-project-*.test.ts` ficam na suíte da API e rodam com o banco de teste; o resto é ferramenta manual e fora da suíte (`*.measure.ts`, `*.measure.browser.tsx`).

## Defeitos encontrados

Nenhum defeito de verdade: nenhuma requisição devolveu erro nem resultado errado em 20 000 tickets; a lista, o detalhe, a atividade, as ideias, as escritas e o MCP responderam e passaram na validação de saída em todas as escalas. Observação de comportamento (não corrigida): o limite de 60 chamadas por minuto por token impede enumerar projetos grandes pelo MCP em tempo razoável (ver acima).

## Correções e medições posteriores (2026-11-23)

- **O item 6 (quadros de zoom e arraste) estava errado para cima.** A medição do navegador deste documento rodava o React de desenvolvimento, com a máquina carregada. Com o React de produção (`pnpm --filter @treepm/web measure:map-frame`, TREEPM-247), a 20 000 tickets o arraste fica em p95 de 16,8 ms, sem nenhum quadro acima de 33 ms, e o zoom em p95 de 33,4 ms, com 14 de 244 quadros acima de 33 ms e pior quadro de 83 a 117 ms. O custo do quadro não cresce com o número de tickets: cresce com o número de elementos que ficam na tela no nível de zoom (até cerca de 2 750 no pico), e está no navegador (estilo e pintura, cerca de 8 dos 11 a 20 ms), não no React (1,3 a 1,9 ms) nem na engine. Os p95 de quadro da seção do navegador acima não valem como números de usuário.
- **Corrigido desde então, sem mudar contrato nem aparência:** itens 2, 3, 7, 9 e 10 na API (PR #166: lista 775 → 351 ms, detalhe fundo 101 → 31 ms, mover 176 → 30 ms, enumeração pelo MCP 11,4 → 4,4 s, a 20 000 tickets) e itens 4, 5 e 8 e a comparação da atualização automática na web (PR #165: montar os itens 125 → 34,5 ms, escala máxima 125–157 → 0,23 ms, comparação 79 → 10,5 ms, busca por tecla 93–99 → 5,5–11 ms). O índice de pai para filhos (migration `0024`, PR #167) leva o detalhe raso de 87,5 para 21,5 ms.
- **Defeito achado pela medição:** a partir de cerca de 16 000 tickets a lista devolvia a mesma pessoa duas vezes como responsável; corrigido no PR #166.
- **Continua em aberto:** a lista inteira baixada ao abrir e a cada 30 s (item 1; pede atualização incremental, com mudança de contrato), a compressão das respostas, a visão geral do MCP, e os quadros de pico do zoom, cuja melhora de verdade exige mudar como o card é dimensionado na tela (decisão de produto).
