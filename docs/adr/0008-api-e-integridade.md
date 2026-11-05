# ADR 0008 — API REST e integridade das escritas

**Status:** Aceita
**Data:** 2026-11-04

## Contexto

A UI precisa criar, editar, reparentar e excluir trabalho sem produzir ciclos, responsáveis inválidos, pais inexistentes ou arestas órfãs. Validar somente no frontend permitiria contornar as regras por HTTP.

## Decisão

Fastify expõe uma REST pequena; zod valida bodies estritos e a API executa todas as mutações pelo `TreeRepository`:

- `GET /api/health`, `/api/bootstrap`, `/api/projects`, `/api/users` e `/api/projects/:projectId`.
- `POST /api/projects/:projectId/tickets` e `PATCH /api/tickets/:ticketId`.
- `DELETE /api/tickets/:ticketId?recursive=true|false`.
- `POST /api/projects/:projectId/edges`, `PATCH /api/edges/:edgeId` e `DELETE /api/edges/:edgeId`.
- `POST /api/projects/:projectId/tickets/suggest` para Jev, sem criar ticket.

Criação e reparenting validam existência do pai, self-parent e ciclos. Responsáveis e componentes validam IDs, duplicidades e limites de schema. Status de pai retorna `409 PARENT_STATUS_DERIVED`. Dependências verificam projeto, duplicidade e ciclos; hierarquia protegida não pode ser excluída como aresta isolada.

Excluir nó com filhos sem `recursive=true` retorna `409 HAS_CHILDREN`. Com o parâmetro e a confirmação explícita da UI, remove a subárvore e todas as arestas incidentes. Erros de regra usam JSON `{ error, message }` e status 4xx; falhas inesperadas retornam erro 500 genérico e são registradas pela API.

## Consequências

A mesma integridade vale para home, legado e chamadas HTTP diretas. O repositório confirma a mutação antes de publicar o novo snapshot.

A exclusão atual é destrutiva, sem lixeira ou auditoria. Soft delete, autorização e histórico são trabalho futuro. Não existe endpoint de login nem qualquer inferência de autenticação a partir dos usuários seed.
