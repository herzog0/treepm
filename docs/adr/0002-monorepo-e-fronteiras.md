# ADR 0002 — Monorepo TypeScript e fronteiras

**Status:** Aceita
**Data:** 2026-11-04

## Contexto

Web, API, admin e regras de árvore compartilham tipos e agregados, mas têm responsabilidades de execução e segurança distintas. Misturar SDK externo, persistência ou regras de integridade nos frontends dificultaria validação e exporia configuração sensível.

## Decisão

Adotar workspaces pnpm com ESM e TypeScript estrito, usando Node **22.23.1** e pnpm **10.25.0**:

- `apps/web`: React e Vite; home espacial, legado, Lista/Kanban e formulários.
- `apps/api`: Fastify e zod; REST, integridade das escritas, repositório e classificador Jev.
- `apps/admin`: React e Vite; leitura operacional da mesma API.
- `packages/domain`: tipos e regras puras de árvore, progresso, ciclos, layout e `TreeIndex`, sem React, Fastify ou SDK externo.

Imports relativos em TypeScript ESM usam extensão `.js`, inclusive entre arquivos `.ts`. Dependências são declaradas no workspace que as consome. `@xyflow/react` permanece instalado na web, mas o canvas semântico atual do legado usa DOM/SVG próprios; a home espacial usa DOM e CSS próprios.

A API é a única detentora de `TYPESAFE_API_KEY` e do SDK TypeSafe AI **0.7.0**. Frontend e admin recebem dados por HTTP, nunca segredos ou acesso direto ao repositório.

## Consequências

O domínio pode ser compilado e reutilizado sem acoplar apresentação ou infraestrutura. A integridade continua na API mesmo que alguma regra pura seja compartilhada.

A alternativa de duplicar agregados em cada app foi rejeitada por divergência. Uma biblioteca de canvas única para home e legado também foi rejeitada porque seus modelos de cena e gestos são diferentes. Builds continuam separados por app, antecedidos pelo build do domínio.
