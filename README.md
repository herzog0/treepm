# TreePM

Plataforma de gerenciamento de projetos com **home espacial Prezi** em `/` e experiência completa de **árvore top-down** em `/legacy`. Inclui tickets recursivos, dependências independentes no legado, Lista e Kanban, API REST e backoffice inicial.

Comece por [docs/platform-overview.md](docs/platform-overview.md) para uma visão geral navegável e por [docs/adr/README.md](docs/adr/README.md) para as decisões duradouras. A visão de produto está em [docs/vision.md](docs/vision.md), os detalhes técnicos em [docs/architecture.md](docs/architecture.md) e as perguntas ainda reais em [docs/open-questions.md](docs/open-questions.md).

## Stack e arquitetura

- **Node 22.23.1 + pnpm 10.25.0**, workspaces, TypeScript estrito e ESM.
- `apps/web`: React, Vite e `@xyflow/react`; plataforma do usuário e canvas.
- `apps/api`: Fastify, REST validada com zod, CORS e `@typesafe-ai/sdk` 0.7.0 (Jev).
- `apps/admin`: React e Vite; visão operacional de projetos, tickets e usuários seed.
- `packages/domain`: tipos e regras puras de árvore, progresso, ciclos, layout tidy e `buildTreeIndex` para agregados compartilhados em O(N), além dos sorts de irmãos.
- **Persistência desta fatia:** JSON local com seed, fila de escritas e rename atômico, isolado por `TreeRepository`. **Produção exige banco transacional**, concorrência multi-instância e migrações; o arquivo local não oferece essas garantias.

Não há autenticação nem autorização. Usuários são apenas identidades seed. Auth, permissões e proteção do backoffice são a próxima etapa; não exponha esta versão.

## Instalação e execução

Pré-requisitos: as versões exatas de Node e pnpm indicadas acima.

```bash
pnpm install
pnpm dev
```

Endereços:

- Web: http://localhost:5173
- Admin: http://localhost:5174
- API e health: http://localhost:3001/api/health (bind padrão somente em `127.0.0.1`; `HOST` explícito pode alterá-lo)

Os Vites usam proxy `/api` para a API. Para build de produção, o frontend aceita `VITE_API_URL` (por exemplo, `https://api.exemplo.com/api`). A chave da TypeSafe AI **nunca** deve usar prefixo `VITE_` nem ser incluída no frontend.

### Jev opcional

```bash
cp apps/api/.env.example apps/api/.env
# exporte a variável no shell que inicia a API; não a coloque em código ou frontend
export TYPESAFE_API_KEY="sua-chave"
pnpm --filter @treepm/api dev
```

Sem `TYPESAFE_API_KEY`, `POST /api/projects/:projectId/tickets/suggest` retorna `mode: "unavailable"`, `manualRequired: true` e orientação explícita de seleção manual. Com chave, a API usa `TypeSafeClient`, `systemOne`, `Choice` por nível e `defaultModel: "jev-latest"`. Se qualquer nível tiver mais de 20 candidatos ou a árvore ultrapassar os seis níveis analisáveis, a API também exige escolha manual e explica a limitação em vez de cortar ramos silenciosamente. Sugestões não criam nem alteram tickets.

## Comandos

```bash
pnpm dev          # domain + API + web + admin em paralelo
pnpm typecheck    # TypeScript estrito nos três apps
pnpm lint         # ESLint no workspace
pnpm build        # domain, API e bundles web/admin
pnpm --filter @treepm/api start   # API já compilada
```

Não há suíte de testes nesta primeira fatia, deliberadamente. A verificação usa typecheck, lint, build e chamadas HTTP reais.

## Dados locais

Na primeira execução a API cria `apps/api/data/treepm.json` ao rodar a partir de `apps/api` (ou `./data/treepm.json` a partir do diretório de execução). O diretório `apps/api/data/` está no `.gitignore`. Configure `TREEPM_DATA_FILE` para escolher outro caminho local. Para recuperar o seed em desenvolvimento, pare a API e remova somente esse arquivo gerado.

## O que já funciona

- Hierarquia recursiva ilimitada com um único `parentId` nullable, múltiplos responsáveis e componentes com responsáveis próprios.
- Home `/` com regiões retangulares Prezi: filhos abaixo do pai em slots uniformes, gerações fisicamente menores, zero overlaps e contornos discretos sem arestas. Zoom contínuo acumula microdeltas com ganho 0,0016 e alcance adaptativo (`max(6, 140 / menorLarguraNormalizada)`) para toda folha ficar legível por wheel ou **Explorar ramo**. Inclui LOD full/compact/chip/dot, culling, pan, fit/reset, breadcrumb e modo de cores por `c`/`C` com wash animado. `/legacy` continua com árvore, Lista e Kanban.
- Status manual somente em folhas; pais mostram `doneLeaves/totalLeaves`, percentual, rótulo e cor acessível. Agregados homogêneos preservam a cor; combinações viram `mixed`/laranja com contagens e tooltip acessível.
- Legado com a árvore A integrada: compactação bottom-up por altura da subárvore (`full → compact → chip → dot → agregado`), resumos reconciliados, minimapa e enquadramento. Todo pai conserva indicadores acessíveis dos filhos imediatos; dots agregados usam microdots de 6 px com alvos de 20 px.
- Wheel negativo sobre ticket resume progressivamente só sua subárvore até dot+indicadores, preservando irmãos e permitindo reversão com wheel+. Em fundo livre, a compactação global cobre a altura máxima até a raiz. O afastamento geométrico acompanha a cena, e a referência de fundo é remapeada pelo envelope a cada frame, sem fit/center.
- Numa sessão curta com as **mesmas coordenadas**, a `WheelAnchor` inteira é preservada — identidade, tipo, presença do nó, razão relativa, cena, envelope e fallbacks — mesmo se a animação colocar um alvo sob o mouse parado. Coordenadas novas capturam alvo explícito, referência local de borda a até 48 px ou cena crua somente em fundo livre. Um novo alvo troca a transição a partir da cena visível; a navegação usa `anchor.ticketId`, nunca um hit acidental do DOM. A referência local segue card → indicador → agregado, sem misturar o ancestral antes da prévia desaparecer. Depois do evento não há follow nem drag+wheel, com ou sem `Ctrl`/`Meta`; `Ctrl`/`Meta` altera somente escala geométrica. A seleção nunca recentraliza a câmera; somente o enquadramento explícito muda essa política.
- **Foco no clique** começa desligado: clicar ou pressionar Enter apenas abre os detalhes, sem mudar foco, LOD ou cena. Ligado, o próximo clique usa 104% (três passos semânticos de 0,12), identificador + título truncado e até três gerações de contexto no dataset atual; alternar o toggle não move a árvore. Breadcrumb continua foco explícito.
- Zoom+ sobre outro card transfere atenção progressivamente e de forma reversível; zoom-out não troca foco para estabilizar a câmera. Scrolls rápidos retomam da cena visível sem fila. Wheel/controles animam por 180 ms e clique focalizado/breadcrumb por 220 ms, com movimento reduzido.
- Arraste esquerdo ou do meio funciona no fundo e sobre cards após um pequeno threshold. Durante qualquer wheel, o zoom tem prioridade e nenhum drag compõe pan, com ou sem `Ctrl`/`Meta`. `lostpointercapture` não interrompe o gesto com botão pressionado; `Shift` + wheel faz pan horizontal imediato.
- Clique real no fundo e `Escape` fora de campos editáveis limpam ticket/aresta selecionados e fecham o painel. Interrupções fazem settle de cena e atenção, sem cards acinzentados ou highlight residual após pan, fit, Shift+wheel ou mudança de foco.
- Conexões `TicketEdge` independentes, selecionáveis e com cor, espessura e tracejado próprios.
- Dependências criadas por conector ou painel, removíveis sem alterar a hierarquia; ciclos e IDs inválidos são rejeitados.
- Criação recursiva, edição, reparenting, exclusão segura, Lista e Kanban acessíveis por tabs.
- Seed profundo e ramificado, e backoffice consumindo a mesma API.

## Protótipos DEV de referência

A home `/` abre a constelação espacial; a árvore semântica integrada fica em `/legacy`. Com `pnpm dev`, `/legacy?variant=A`, `/legacy?variant=B`, `/legacy?variant=C` e `/legacy?variant=D` continuam disponíveis somente como referências descartáveis. C e D representam futuras views de faixas e Lista hierárquica, ainda não promovidas. O código fica em `apps/web/src/components/prototypes/` e não altera dados.

Na árvore, `C` ou o botão **Cores** alterna o preenchimento pelo status, sem interferir em campos editáveis e respeitando movimento reduzido. A avaliação histórica, as medições de gestos e os próximos passos estão em [docs/semantic-zoom-proposal.md](docs/semantic-zoom-proposal.md).

## Limites desta fatia

- Sem login, permissões, billing, colaboração em tempo real, undo, auditoria ou deploy.
- JSON é single-process; não é adequado a produção nem a múltiplas réplicas.
- A árvore compartilha um único índice derivado por snapshot e cacheia a cena de destino de cada animação; o layout semântico usa duas passagens lineares e o blend só percorre a união das cenas. Ainda assim, toda a cena lógica permanece em DOM/SVG, sem worker ou WebGL; a contenção de paint depende do browser, e Lista/Kanban continuam sem virtualização.
- Pinch dedicado e animação FLIP com Web Animations API ainda não foram implementados; Ctrl/Meta + wheel e controles cobrem a escala nesta fatia.
- Não há suíte automatizada permanente nesta etapa; os gestos são verificados com harnesses CDP temporários, sem constituir uma suíte committed.
- Jev com credencial depende do serviço externo; apenas o fallback sem chave é verificável offline.
