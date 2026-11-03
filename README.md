# TreePM

Plataforma de gerenciamento de projetos cuja visão principal é uma **árvore top-down**. Esta fatia executável inclui canvas com zoom semântico, tickets recursivos, dependências independentes, Lista e Kanban, API REST e backoffice inicial.

A visão de produto está em [docs/vision.md](docs/vision.md), as decisões técnicas em [docs/architecture.md](docs/architecture.md) e as perguntas ainda reais em [docs/open-questions.md](docs/open-questions.md).

## Stack e arquitetura

- **Node 22.23.1 + pnpm 10.25.0**, workspaces, TypeScript estrito e ESM.
- `apps/web`: React, Vite e `@xyflow/react`; plataforma do usuário e canvas.
- `apps/api`: Fastify, REST validada com zod, CORS e `@typesafe-ai/sdk` 0.7.0 (Jev).
- `apps/admin`: React e Vite; visão operacional de projetos, tickets e usuários seed.
- `packages/domain`: tipos e regras puras de árvore, progresso, ciclos e layout tidy.
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
- Status manual somente em folhas; pais mostram `doneLeaves/totalLeaves`, percentual, rótulo e cor acessível.
- Layout tidy determinístico baseado nas folhas, pan, zoom, fit view, minimapa e controles.
- Zoom semântico: cards completos, compactos, resumos por subárvore e visão do projeto. Renderização somente de elementos visíveis no canvas.
- Conexões `TicketEdge` independentes, selecionáveis e com cor, espessura e tracejado próprios.
- Dependências criadas por handles ou painel, removíveis sem alterar a hierarquia; ciclos e IDs inválidos são rejeitados.
- Criação recursiva, edição, reparenting, exclusão segura, Lista e Kanban acessíveis por tabs.
- Seed profundo e ramificado, e backoffice consumindo a mesma API.

## Protótipo descartável de UX (temporário, somente DEV)

Com `pnpm dev`, acesse `/?variant=A`, `/?variant=B`, `/?variant=C` ou `/?variant=D` para comparar viewport adaptativa, foco explícito, dois controles e lista hierárquica. Na A, `C` ou o botão **Cores** alterna o preenchimento animado dos cards pelo status; o atalho não interfere em campos editáveis e respeita movimento reduzido. A direção aprovada é A para a árvore, com C como futura view de faixas e D como futura Lista hierárquica, ainda não promovidas às tabs de produção. O código fica isolado em `apps/web/src/components/prototypes/`, usa apenas o bootstrap em modo leitura e não representa decisão de produção. Setas ou o switcher inferior trocam de variante; a query permanece estável no reload. Sem a query válida — ou fora de DEV — a experiência de produção permanece inalterada.

A avaliação visual, os resultados do Jev e a proposta de implementação estão em [docs/semantic-zoom-proposal.md](docs/semantic-zoom-proposal.md), com screenshots em `docs/assets/semantic-zoom/`.

## Limites desta fatia

- Sem login, permissões, billing, colaboração em tempo real, undo, auditoria ou deploy.
- JSON é single-process; não é adequado a produção nem a múltiplas réplicas.
- LOD agrega em profundidades fixas nesta primeira heurística; não há virtualização de Lista/Kanban nem algoritmo incremental para árvores enormes.
- Sem testes automatizados, conforme decisão desta etapa.
- Jev com credencial depende do serviço externo; apenas o fallback sem chave é verificável offline.
