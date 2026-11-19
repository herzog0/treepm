# Decisões atuais

| ADR | Data | Decisão |
| --- | --- | --- |
| [0016 — Engine espacial isolada](0016-engine-espacial-isolada.md) | 2026-11-04 | Reinício com biblioteca genérica e demo local. |
| [0017 — Árvore genérica e apresentação](0017-arvore-generica-e-apresentacao.md) | 2026-11-05 | Contrato headless, React opcional e agrupamento por quadrados mesclados. |
| [0018 — Geometria e semântica do renderer](0018-geometria-e-semantica-do-renderer.md) | 2026-11-05 | Aplicação geométrica no commit, conteúdo declarativo e culling dos retângulos de regiões. |
| [0019 — Clerk: organização como tenant](0019-clerk-organizacao-como-tenant.md) | 2026-11-19 | Tenant por Clerk Organization, `org_id` do token verificado, papéis de time e projeto no domínio. |
| [0020 — Fluxo do Clerk dentro da SPA](0020-fluxo-do-clerk-na-spa.md) | 2026-11-19 | Entrada, cadastro e tarefa de organização em componentes locais do Clerk. |
| [0021 — Neon PostgreSQL e RLS por organização](0021-neon-postgres-e-rls-por-organizacao.md) | 2026-11-19 | Neon com Prisma, papel de aplicação sem bypass, política por `org_id`, contexto transacional por requisição e suíte de testes permanente. |
| [0022 — API NestJS na Fly.io](0022-api-nestjs-e-hospedagem-na-fly.md) | 2026-11-19 | API NestJS com Zod em `apps/api`, uma origem em `treepm.ai`, região São Paulo. |
| [0023 — Telas de administração e mapa da organização](0023-telas-de-administracao-e-mapa-da-organizacao.md) | 2026-11-19 | Times em área dedicada (`?view=teams`), áreas e projetos em painel lateral, mapa com a organização na raiz e cliente da API sem cache. |
| [0024 — Tickets: primeiro recorte e importação por lista](0024-tickets-primeiro-recorte-e-importacao-por-lista.md) | 2026-11-19 | Recorte da Fase 2: `tickets` e `ticket_assignees` com RLS, número por projeto, situação só em folha e progresso derivado, permissões por papel de projeto, API de tickets e importação atômica de uma lista em Markdown interpretada na web. |

A base anterior foi preservada no checkpoint Git `33c4702`; seus documentos de implementação foram removidos junto com o produto. Novas decisões usam números sequenciais a partir de 0025.
