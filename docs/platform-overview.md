# TreePM — visão geral da plataforma

**Estado do documento:** arquitetura implementada em 2026-11-04. Recursos futuros estão marcados como tal e reunidos em [Perguntas abertas](open-questions.md).

O TreePM gerencia trabalho recursivo com tickets, múltiplos responsáveis, progresso derivado das folhas e dependências independentes. A experiência principal é uma home espacial Prezi; uma experiência top-down completa permanece disponível no legado, e um backoffice inicial oferece leitura operacional.

## Mapa de leitura

- [Índice das ADRs](adr/README.md): decisões duradouras no formato Contexto/Decisão/Consequências.
- [Visão de produto](vision.md): direção e vocabulário da experiência.
- [Arquitetura](architecture.md): detalhes de implementação, cena e medições históricas.
- [Perguntas abertas](open-questions.md): escolhas ainda não decididas e limites de escala.

Decisões por tema:

| Tema | ADR |
| --- | --- |
| Produto, público e telas | [0001](adr/0001-visao-e-publico.md) |
| Monorepo e fronteiras | [0002](adr/0002-monorepo-e-fronteiras.md) |
| Tickets e progresso | [0003](adr/0003-tickets-e-progresso.md) |
| Hierarquia e dependências | [0004](adr/0004-hierarquia-e-dependencias.md) |
| Home espacial | [0005](adr/0005-home-espacial.md) |
| Câmera e gestos | [0006](adr/0006-camera-e-gestos.md) |
| Legado e protótipos | [0007](adr/0007-legado-e-prototipos.md) |
| API e integridade | [0008](adr/0008-api-e-integridade.md) |
| Persistência, seed e admin | [0009](adr/0009-persistencia-identidade-e-admin.md) |
| Jev e TypeSafe AI | [0010](adr/0010-jev-e-typesafe-ai.md) |
| Performance | [0011](adr/0011-performance-e-renderizacao.md) |
| Segurança, configuração e validação | [0012](adr/0012-seguranca-configuracao-e-validacao.md) |

## Produto, público e telas

A plataforma atende pessoas que coordenam descoberta, design e engenharia em árvores de trabalho, inclusive subtarefas geradas com IA. Não há owner único: tickets e componentes aceitam múltiplos responsáveis.

| Superfície | Situação atual |
| --- | --- |
| `/` | Home espacial principal, com constelações, agregados, pan, zoom e detalhes. |
| `/legacy` | Árvore top-down, Lista, Kanban, formulários, dependências e zoom semântico. |
| `/legacy?variant=A…D` | Referências somente DEV; C/D não são views de produção. |
| Admin em `5174` | Visão geral, projetos, tickets com busca e usuários seed, por leitura da mesma API. |

Usuários seed demonstram atribuição e identidade visual. Não são contas autenticadas. Não há login, permissões, colaboração em tempo real ou backoffice protegido nesta fatia. Ver [ADR 0001](adr/0001-visao-e-publico.md).

## Arquitetura e fronteiras

```text
apps/web (React/Vite) ─────┐
                           ├── HTTP /api ── apps/api (Fastify/zod)
apps/admin (React/Vite) ───┘                    │
                                               ├── TreeRepository / JSON local
                                               └── Jev / TypeSafe AI

packages/domain ── tipos e regras puras compartilhadas, sem SDK ou infraestrutura
```

- Node **22.23.1**, pnpm **10.25.0**, workspaces, ESM e TypeScript estrito.
- A API valida integridade e é a única detentora da credencial de IA e do repositório.
- A home espacial não reutiliza a máquina de gestos do legado; bootstrap, dados e `TreeIndex` são compartilhados.
- `@xyflow/react` permanece instalado na web, mas a árvore semântica atual usa DOM/SVG próprios.

Ver [ADR 0002](adr/0002-monorepo-e-fronteiras.md).

## Dados e regras

`Ticket` possui projeto, sequência, `parentId` nullable, título, descrição, status, responsáveis, componentes e timestamps. Cada componente tem nome e responsáveis próprios.

Somente folhas editam status manualmente. Pais apresentam folhas concluídas/total, percentual, categoria e texto derivados de todas as folhas descendentes. Todas têm peso igual nesta fatia. Agregados homogêneos preservam a cor; combinações usam `mixed`/laranja com texto e contagens acessíveis. Ver [ADR 0003](adr/0003-tickets-e-progresso.md).

`TicketEdge` distingue:

- `hierarchy`: sincronizada com `parentId` e protegida contra exclusão isolada.
- `dependency`: relação independente, com identidade, metadados, cor, espessura e tracejado próprios.

Criar ou remover dependência não muda o pai. A API rejeita ciclos hierárquicos e de dependências, self-loops, duplicidades e relações entre projetos. Dependências ainda não bloqueiam execução ou conclusão. Ver [ADR 0004](adr/0004-hierarquia-e-dependencias.md).

## Navegação espacial e legado

### Home `/`

As regiões retangulares são calculadas bottom-up por altura de subárvore. Todo pai usa `ceil(sqrt(n))` colunas, linhas centralizadas e slots com o envelope completo de cada filho, sempre abaixo da sua borda inferior. Posições, dimensões e bounds recebem a mesma normalização; slots e linhas disjuntos garantem zero overlap sem transformar a experiência em um grid plano. A primeira cena apresenta root e filhos imediatos em duas linhas de três, com contornos discretos e sem arestas top-down. Ver [ADR 0013](adr/0013-regioes-retangulares-uniformes.md).

O wheel preserva o ponto mundial sob o cursor e acumula deltas em coordenadas estáveis num único loop temporal, com ganho 0,0016 após normalizar `deltaMode`. Isso corrige os reinícios de animação que perdiam microdeltas; burst e deslocamento agregado produzem a mesma razão. Pan começa imediatamente após zoom e pode combinar drag com wheel; clique abre detalhes, **Explorar ramo**/breadcrumb faz o mergulho e fit/reset centraliza `initialBounds`. Reduced motion aplica o alvo imediatamente. Ver [ADR 0006](adr/0006-camera-e-gestos.md) e [ADR 0015](adr/0015-pan-imediato-e-wheel-simultaneo.md).

O alcance deriva de `max(6, 140 / menorLarguraNormalizada)`, sem teto fixo que impeça a leitura. No snapshot retangular registrado na ADR 0013, equivalia a aproximadamente **1.505,187×**; o valor é recalculado a cada árvore. Foco e wheel compartilham esse alcance. Quando a leitura exige mais que o fit da subárvore, o próprio alvo é centralizado com **140 px**, em vez de desaparecer ou ficar fora da tela. No zoom-out, full, compact, dot e agregados voltam pelos mesmos thresholds.

O preenchimento por status começa ligado. A tecla `c`/`C` e o botão **Cores** alternam o preenchimento com wash animado de cima para baixo e texto branco. O wash cobre todo o contorno arredondado, incluindo a faixa superior e as bordas. Modificadores, repeat e campos editáveis não disparam o atalho; `aria-pressed` comunica o estado. Dots e agregados `mixed` preservam suas cores.

Os quadradinhos sob um pai se deslocam e crescem até virar os tickets correspondentes conforme o zoom; ao afastar, fazem o caminho inverso. Cada filho tem uma representação por vez, e os filhos seguintes aparecem como novos quadradinhos. A cena acompanha a câmera, com culling das posições intermediárias e grupos `+N` quando necessário. Ver [ADR 0014](adr/0014-continuidade-indicador-ticket.md).

### Legado `/legacy`

A árvore semântica compacta folhas antes dos pais por `subtreeHeight`, mantém agregados reconciliados e conserva `WheelAnchor` em coordenadas estáveis. Lista e Kanban usam os mesmos tickets e progresso. Protótipos DEV não alteram dados nem representam compromissos de produção. Ver [ADR 0007](adr/0007-legado-e-prototipos.md).

## API REST

| Método e rota | Finalidade |
| --- | --- |
| `GET /api/health` | Estado da API, persistência e fallback de Jev. |
| `GET /api/bootstrap` | Projetos, tickets, arestas e usuários. |
| `GET /api/projects`, `/api/users`, `/api/projects/:projectId` | Leituras de projeto e usuários. |
| `POST /api/projects/:projectId/tickets` | Criação validada de ticket. |
| `PATCH /api/tickets/:ticketId` | Edição e reparenting com integridade. |
| `DELETE /api/tickets/:ticketId?recursive=true|false` | Exclusão segura; subárvore exige `recursive=true`. |
| `POST /api/projects/:projectId/edges` | Nova dependência no mesmo projeto. |
| `PATCH /api/edges/:edgeId` | Estilo individual da aresta. |
| `DELETE /api/edges/:edgeId` | Remove dependência; hierarquia é protegida. |
| `POST /api/projects/:projectId/tickets/suggest` | Sugestão Jev sem criar ticket. |

Bodies são validados por zod. Erros de regra retornam `{ error, message }` e status 4xx. Exclusão recursiva também exige confirmação explícita na UI. Ver [ADR 0008](adr/0008-api-e-integridade.md).

## IA opcional

Jev usa TypeSafe AI **0.7.0** somente na API. A classificação escolhe categoria e percorre até seis níveis, com no máximo 20 candidatos por nível e opção `__stop__` para permanecer no pai.

- Sem chave: `unavailable` e seleção manual.
- Limites da árvore: explicação e `manualRequired=true`, sem cortar ramos.
- Confiança abaixo de **0,65**: revisão manual.
- Erro externo: `error`, sem presumir classificação.
- Sugestão disponível: a pessoa revisa, confirma e só então cria pela rota normal.

`TYPESAFE_API_KEY` nunca é enviada ao frontend nem usa prefixo `VITE_`. Ver [ADR 0010](adr/0010-jev-e-typesafe-ai.md).

## Persistência e identidade

O `JsonTreeRepository` clona snapshots, serializa mutações em uma fila e grava arquivo temporário seguido de `rename` atômico. Na ausência do arquivo, cria o seed. `TREEPM_DATA_FILE` escolhe outro caminho local; dados gerados ficam fora do Git.

Essas garantias valem **somente dentro de um processo**. Não há locking multi-processo, migrações, transações relacionais, réplicas ou recuperação transacional. Produção exige outra implementação de `TreeRepository` com banco transacional.

O admin lê o mesmo bootstrap e identifica explicitamente o ambiente local sem autenticação. Ver [ADR 0009](adr/0009-persistencia-identidade-e-admin.md).

## Performance

`buildTreeIndex` calcula agregados em O(N), além da ordenação de irmãos, e compartilha mapas por snapshot. A home limita o DOM por viewport e revelação de ancestrais; mesmo no zoom profundo, ancestrais fora da tela são descartados.

O legado usa memoização, `WeakMap`, caches CSSOM, fast path no rAF e cenas de destino reutilizadas. A apresentação continua em DOM/SVG. Não há workers, WebGL nem virtualização geral; Lista e Kanban renderizam todos os tickets. Limites para árvores maiores exigem novas medições, não suposições. Ver [ADR 0011](adr/0011-performance-e-renderizacao.md).

## Configuração e desenvolvimento

Ports padrão: API `3001`, web `5173`, admin `5174`. A API escuta em `127.0.0.1` salvo `HOST` explícito; CORS é restrito aos frontends locais.

Variáveis: `PORT`, `HOST`, `LOG_LEVEL`, `TREEPM_DATA_FILE`, `VITE_API_URL` e `TYPESAFE_API_KEY` somente na API. A referência sem segredos é `apps/api/.env.example`.

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm build
```

Ver [ADR 0012](adr/0012-seguranca-configuracao-e-validacao.md).

## Validação

A convenção atual não adota suíte permanente. Os portões são `pnpm lint`, `pnpm typecheck`, `pnpm build` e `git diff --check`, complementados por endpoints reais e harnesses CDP temporários.

Na revisão da navegação profunda:

- o layout manteve **zero overlaps em 500.500 pares**;
- `node .tmp-deep-zoom-repro.mjs` percorreu a árvore até a folha real de depth 7 e terminou em `full`, com **140 px**;
- o wheel contínuo alcançou a mesma folha com erro de âncora abaixo de **0,007 px**;
- zoom-out restaurou `full → compact → dot`;
- overview, `/legacy`, mobile, console limpo e ausência de escritas HTTP foram verificados.

Harnesses temporários não constituem suíte committed. O dataset é preservado; harnesses, perfis e capturas temporárias são removidos após a verificação.

## Limites atuais e próximos passos

Não implementados: autenticação/autorização, banco transacional, colaboração em tempo real, auditoria, undo, lixeira, billing, deploy, pinch dedicado e promoção dos protótipos C/D. Jev com credencial depende do serviço externo; somente o fallback é verificável offline.

As decisões futuras incluem peso do trabalho, estado bloqueado, semântica de dependências, papéis/permissões, escala do canvas, calibração de Jev, persistência de produção e política de exclusão. O registro aberto está em [open-questions.md](open-questions.md); nenhum desses itens deve ser apresentado como recurso atual.
