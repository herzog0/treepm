# @treepm/db

Prisma 7 + PostgreSQL com isolamento por organização via RLS (ADR 0021).

- `DATABASE_URL`: papel `treepm_app`, conexão com pool; única conexão da API.
- `DATABASE_MIGRATION_URL`: papel dono, conexão direta; só migrações.

Exporta `createPrismaClient`, `withTenant` e os tipos/enums gerados. Todo acesso a dados passa por `withTenant(prisma, { orgId, userId }, fn)`.

## Comandos

```sh
pnpm --filter @treepm/db db:test:up     # PostgreSQL 17 de teste (treepm-test-postgres, porta 54329)
pnpm --filter @treepm/db test           # aplica as migrações reais e roda o Vitest
pnpm --filter @treepm/db db:test:down   # derruba o contêiner
pnpm --filter @treepm/db build          # prisma generate + tsc
pnpm --filter @treepm/db typecheck
DATABASE_MIGRATION_URL=... pnpm --filter @treepm/db migrate:deploy
```

Migrações em `prisma/migrations`: `0001` tabelas e `app_uuid_v7()`, `0002` papel `treepm_app` e grants, `0003` RLS forçado e políticas, `0004` tickets, `0005` conversas de novo ticket com a IA, `0006` tipo do nó (`ticket` ou `group`, ADR 0031): a coluna `kind`, e `parent_kind` na chave estrangeira do pai, que só aceita `group` (por isso só agrupador tem filhos, mesmo em requisições simultâneas). Em produção `treepm_app` nasce `NOLOGIN`; a senha é definida fora do Git.
