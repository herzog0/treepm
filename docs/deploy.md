# Deploy (Fly.io, uma origem)

Contrato em `docs/adr/0022-api-nestjs-e-hospedagem-na-fly.md`. Um app serve `treepm.ai`: a API NestJS atende `/api/*` e, quando `WEB_DIST_DIR` está definida, os estáticos do web no restante (fallback `index.html`; `/assets/*` com cache imutável, `index.html` com `no-cache`). **Nada abaixo foi publicado**: `Dockerfile` e `fly.toml` só foram verificados localmente.

## Variáveis

| Nome | Onde | Observação |
| --- | --- | --- |
| `VITE_CLERK_PUBLISHABLE_KEY` | argumento de build (`--build-arg`) | Chave pública, embutida no bundle do web. Não é secret de runtime. |
| `NODE_ENV`, `PORT`, `WEB_DIST_DIR`, `APP_ORIGIN` | `[env]` do `fly.toml` | Não secretas. `WEB_DIST_DIR` é opcional; sem ela a API não serve estáticos (desenvolvimento). |
| `CLERK_SECRET_KEY` | secret da Fly | Obrigatório. |
| `CLERK_PUBLISHABLE_KEY` | secret da Fly | Obrigatório; mesma chave pública do build. |
| `DATABASE_URL` | secret da Fly | Papel `treepm_app`, conexão com pool. Única conexão da API. |
| `DATABASE_MIGRATION_URL` | **nunca na Fly**; só no ambiente do mantenedor ou do CI | Papel dono, conexão direta. Usada só por `prisma migrate deploy`, fora da Fly. |
| `CLERK_JWT_KEY` | secret da Fly | Opcional (verificação sem rede). |

**Por que migrar fora da Fly.** Na Fly, secrets são variáveis de ambiente de todas as máquinas do app (e da máquina temporária do `release_command`); não existe secret restrito. Para cumprir a ADR 0021 (a URL do papel dono nunca fica no processo da API), o `fly.toml` não tem `release_command`, a imagem não traz o CLI do prisma nem as migrações, e `DATABASE_MIGRATION_URL` nunca é criado na Fly.

## Ordem de cada deploy: migrar, depois publicar

1. Fora da Fly (máquina do mantenedor ou CI), com `DATABASE_MIGRATION_URL` só nesse ambiente:
   `DATABASE_MIGRATION_URL=<url do dono, conexão direta> pnpm --filter @treepm/db migrate:deploy`
2. Só se a migração terminou com sucesso: `fly deploy --build-arg VITE_CLERK_PUBLISHABLE_KEY=<chave pública>`.

**Se a migração falhar:** não publique. A versão em produção segue rodando contra o schema anterior (o `prisma migrate deploy` aplica cada migração em transação e para na primeira que falha). Leia o erro, corrija com uma nova migração versionada (não edite uma já aplicada) e rode de novo. Se uma migração ficou marcada como falha, o `prisma migrate status` mostra qual; resolva com `prisma migrate resolve` só depois de entender o estado do banco. Migrações devem ser compatíveis com a versão anterior da API (expandir antes de contrair), porque a API antiga continua servindo até o deploy terminar.

## Build local da imagem

```sh
docker build --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_test_exemplo -t treepm-local .
```

A imagem roda como o usuário `node` (uid 1000), só com dependências de produção, `dist` da API/`@treepm/db`/`@treepm/domain` (inclui o Prisma Client gerado) e o web em `/app/web`. Sem CLI do prisma e sem migrações. Tamanho: cerca de 551 MB (base `node:22.23.1-slim` com 329 MB).

**Memória da VM.** `fly.toml` usa `shared-cpu-1x` com 256 MB, o menor preset. Medido localmente: o contêiner limitado a 256 MB (sem swap) ficou em cerca de 55 MiB após uma rajada de requisições a `/` e `/api/me`, sem OOM. Não é teste de carga; se a produção estourar, subir para 512 MB.

## Rodar a imagem contra o PostgreSQL de teste

```sh
pnpm --filter @treepm/db db:test:up        # porta 54329; migre o banco antes (ex.: rodando a suíte da API)
docker run --rm --network host \
  -e PORT=3100 -e WEB_DIST_DIR=/app/web -e APP_ORIGIN=https://treepm.ai \
  -e DATABASE_URL=<url treepm_app do PostgreSQL de teste, ver packages/db/test/env.ts> \
  -e CLERK_SECRET_KEY=sk_test_exemplo -e CLERK_PUBLISHABLE_KEY=pk_test_exemplo \
  treepm-local
curl -i http://127.0.0.1:3100/api/health   # 200; / e /?demo devolvem HTML; /api/me 401
pnpm --filter @treepm/db db:test:down
```

## Primeiro deploy: passos manuais

Ainda não executados; dependem de autorização do Teodoro (a Fly gera custo).

1. Decidir o nome do app (`treepm` é provisório) e criar o app na Fly.
2. Criar os secrets: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `DATABASE_URL` e, se quiser, `CLERK_JWT_KEY`. Nunca `DATABASE_MIGRATION_URL`.
3. Rodar a primeira migração fora da Fly (ver a ordem acima).
4. Criar a instância de produção do Clerk para `treepm.ai`, com os registros DNS que ela exigir.
5. Apontar o DNS de `treepm.ai` para o app e emitir o certificado na Fly.
6. `fly deploy --build-arg VITE_CLERK_PUBLISHABLE_KEY=<chave pública de produção>`.
