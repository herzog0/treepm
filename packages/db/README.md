# @treepm/db

Prisma 7 + PostgreSQL com isolamento por organização via RLS (ADR 0021).

- `DATABASE_URL`: papel `treepm_app`, conexão com pool; única conexão da API.
- `DATABASE_MIGRATION_URL`: papel dono, conexão direta; só migrações.

Exporta `createPrismaClient`, `withTenant` e os tipos/enums gerados. Todo acesso a dados passa por `withTenant(prisma, { orgId, userId }, fn)`.

## Comandos

```sh
pnpm --filter @treepm/db db:test:up     # PostgreSQL 17 com pgvector (imagem pgvector/pgvector:pg17) de teste (treepm-test-postgres, porta 54329)
pnpm --filter @treepm/db test           # aplica as migrações reais e roda o Vitest
pnpm --filter @treepm/db db:test:down   # derruba o contêiner
pnpm --filter @treepm/db build          # prisma generate + tsc
pnpm --filter @treepm/db typecheck
DATABASE_MIGRATION_URL=... pnpm --filter @treepm/db migrate:deploy
```

Migrações em `prisma/migrations`: `0001` tabelas e `app_uuid_v7()`, `0002` papel `treepm_app` e grants, `0003` RLS forçado e políticas, `0004` tickets, `0005` conversas de novo ticket com a IA, `0006` tipo do nó (`ticket` ou `group`, ADR 0031): a coluna `kind`, e `parent_kind` na chave estrangeira do pai, que só aceita `group` (por isso só agrupador tem filhos, mesmo em requisições simultâneas). A `0009` tirou essa exigência (ADR 0034: todo ticket pode ter filhos) e a `0010` removeu as colunas `kind` e `parent_kind`. Em produção `treepm_app` nasce `NOLOGIN`; a senha é definida fora do Git.

## Extensão `vector` (pgvector)

A migração `0030` (ADR 0053) cria a extensão `vector` e a tabela `ticket_embeddings` (um vetor de 512 números por ticket, com RLS). O banco de teste, o de desenvolvimento e o de produção precisam ter a extensão disponível: o contêiner de teste usa `pgvector/pgvector:pg17` (se o seu foi criado com `postgres:17-alpine`, recrie-o com `db:test:down` e `db:test:up`). No Prisma a coluna é `Unsupported("vector(512)")`: o vetor é lido e escrito só por SQL cru parametrizado (`$queryRaw`/`$executeRaw`, com `::vector`), nunca por `create`/`update` do cliente.

O contêiner de teste sobe com `POSTGRES_INITDB_ARGS: "--locale=C"` (a imagem Debian do pgvector usaria `en_US.utf8`, e alguns testes dependem da ordenação `C`). Um banco criado à mão no contêiner deve usar o mesmo: `create database NOME owner treepm_owner template template0 lc_collate 'C' lc_ctype 'C'`.
