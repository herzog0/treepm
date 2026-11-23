# Deploy (Fly.io, uma origem)

Contrato em `docs/adr/0022-api-nestjs-e-hospedagem-na-fly.md`. Um app serve `treepm.ai`: a API NestJS atende `/api/*` e, quando `WEB_DIST_DIR` está definida, os estáticos do web no restante (fallback `index.html`; `/assets/*` com cache imutável, `index.html` com `no-cache`). **Nada abaixo foi publicado ainda.** Teodoro autorizou a primeira publicação em 2026-11-21 ("Deploy no fly sim"); a preparação foi pedida à coordenação operacional no pedido #8 do PR #62.

## Variáveis

| Nome | Onde | Observação |
| --- | --- | --- |
| `VITE_CLERK_PUBLISHABLE_KEY` | argumento de build (`--build-arg`) | Chave pública, embutida no bundle do web. Não é secret de runtime. |
| `CLIENT_IP_HEADER` | `[env]` do `fly.toml` | Opcional. Nome do cabeçalho com o IP do cliente (`Fly-Client-IP`), usado só pelo limite por IP do servidor MCP; sem ele vale o IP da conexão. Ver o passo 7 do primeiro deploy. |
| `NODE_ENV`, `PORT`, `WEB_DIST_DIR`, `APP_ORIGIN` | `[env]` do `fly.toml` | Não secretas. `WEB_DIST_DIR` é opcional; sem ela a API não serve estáticos (desenvolvimento). |
| `APP_EXTRA_ORIGINS` | — | Só desenvolvimento (origens extras da web, ex.: o endereço da rede privada). Em produção **não** é definida: só `APP_ORIGIN` vale. |
| `CLERK_SECRET_KEY` | secret da Fly | Obrigatório. |
| `CLERK_PUBLISHABLE_KEY` | secret da Fly | Obrigatório; mesma chave pública do build. |
| `DATABASE_URL` | secret da Fly | Papel `treepm_app`, conexão com pool. Única conexão da API. |
| `DATABASE_MIGRATION_URL` | **nunca na Fly**; só no ambiente do mantenedor ou do CI | Papel dono, conexão direta. Usada só por `prisma migrate deploy`, fora da Fly. |
| `CLERK_JWT_KEY` | secret da Fly | Opcional (verificação sem rede). |
| `ANTHROPIC_API_KEY`, `TYPESAFE_API_KEY` | secrets da Fly | Opcionais, mas só valem juntas: sem as duas, a IA fica desligada e o resto funciona (ADR 0029). |
| `GITHUB_APP_ID`, `GITHUB_APP_SLUG`, `GITHUB_APP_CLIENT_ID`, `GITHUB_APP_CLIENT_SECRET`, `GITHUB_APP_PRIVATE_KEY` | secrets da Fly | Opcionais, as cinco juntas: sem elas, a ligação com o GitHub fica desligada (ADR 0032). O app de desenvolvimento (`treepm-dev`) aponta para `localhost`; produção precisa de um app próprio, com a Callback URL de `treepm.ai`. |

**Por que migrar fora da Fly.** Na Fly, secrets são variáveis de ambiente de todas as máquinas do app (e da máquina temporária do `release_command`); não existe secret restrito. Para cumprir a ADR 0021 (a URL do papel dono nunca fica no processo da API), o `fly.toml` não tem `release_command`, a imagem não traz o CLI do prisma nem as migrações, e `DATABASE_MIGRATION_URL` nunca é criado na Fly.

## Ordem de cada deploy: migrar, depois publicar

1. Fora da Fly (máquina do mantenedor ou CI), com `DATABASE_MIGRATION_URL` só nesse ambiente:
   `DATABASE_MIGRATION_URL=<url do dono, conexão direta> pnpm --filter @treepm/db migrate:deploy`
2. Só se a migração terminou com sucesso: `fly deploy --build-arg VITE_CLERK_PUBLISHABLE_KEY=<chave pública>`.

**Se a migração falhar:** não publique. A versão em produção segue rodando contra o schema anterior (o `prisma migrate deploy` aplica cada migração em transação e para na primeira que falha). Leia o erro, corrija com uma nova migração versionada (não edite uma já aplicada) e rode de novo. Se uma migração ficou marcada como falha, o `prisma migrate status` mostra qual; resolva com `prisma migrate resolve` só depois de entender o estado do banco. Migrações devem ser compatíveis com a versão anterior da API (expandir antes de contrair), porque a API antiga continua servindo até o deploy terminar.

## Compressão das respostas (TREEPM-255)

O próprio servidor comprime (`apps/api/src/compression.ts`, registrada em `configureApp`): brotli (qualidade 4) ou gzip (nível 4), conforme o `Accept-Encoding`, para respostas de texto/JSON acima de 1 KB, inclusive os arquivos estáticos do web. A lista de um projeto de 20 000 tickets cai de 13,4 MB para cerca de 1,0 MB (brotli) ou 1,5 MB (gzip). Sempre com `Vary: Accept-Encoding`; o `ETag` fraco da lista e o `304` sem corpo seguem como estavam.

Ficam **sem compressão**: o servidor MCP (`/api/mcp/…`), qualquer fluxo `text/event-stream`, respostas com `Cache-Control: no-transform`, respostas parciais (`206`), imagens e fontes, e as respostas que carregam segredo (criação do token de acesso e a conexão com o GitHub; ataque do tipo BREACH).

O `fly.toml` não pede compressão ao proxy da Fly. Se ele (ou um CDN à frente) comprimir por conta própria, não recomprime o que já chega com `Content-Encoding`; por isso nada precisa ser desligado. Conferir em produção, depois do primeiro deploy com esta mudança: `curl -sI -H 'Accept-Encoding: br' https://treepm.ai/assets/<arquivo>.js` deve trazer `content-encoding: br`.

## Build local da imagem

```sh
docker build --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_test_exemplo -t treepm-local .
```

A imagem roda como o usuário `node` (uid 1000), só com dependências de produção, `dist` da API/`@treepm/db`/`@treepm/domain` (inclui o Prisma Client gerado) e o web em `/app/web`. Sem CLI do prisma, sem migrações e sem os scripts de desenvolvimento de `apps/api/scripts` (`github-check`, `verify-providers`, `placement-rebuild`; precisam do `tsx`). Tamanho: cerca de 619 MB (base `node:22.23.1-slim` com 329 MB), medido em 2026-11-21.

**Memória da VM.** `fly.toml` usa `shared-cpu-1x` com 512 MB. Medido em 2026-11-22 na imagem construída a partir do branch do servidor MCP, em contêiner limitado a 256 MB: ocioso logo depois de subir, 89 a 137 MiB; depois de 600 requisições que não tocam o banco (`/` e `/api/me` sem sessão), 98 MiB; depois de 120 requisições que abrem transação no banco (o endereço MCP com token bem formado e inexistente), 188 MiB, estabilizando em 198 MiB depois de 1.800 requisições (as demais barradas pelo limite por IP), sem OOM. A medição anterior (93 MiB) não passava pelo banco. Com o banco em uso o processo fica perto de 200 MiB e em 256 MB sobra pouco para as chamadas à IA; por isso a máquina passa a 512 MB. Não é teste de carga e não exercita as chamadas à IA.

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

Autorizados por Teodoro em 2026-11-21. Quem executa é a coordenação operacional (conta da Fly, secrets, Clerk e DNS); a coordenação confirma no canal o commit a publicar, depois de reconstruir a imagem a partir do `main` e refazer a conferência do contêiner.

O banco de produção é separado do Neon de desenvolvimento.

**Cadastro restrito no começo** *(escolha da coordenação)*: a instância de produção do Clerk começa com lista de permitidos ou convite. Com cadastro aberto, texto de ticket de outras organizações iria à Anthropic e à TypeSafe sem termo de aceite, que ainda não existe (`TREEPM-81`). Abrir o cadastro espera esse aceite.

1. Decidir o nome do app (`treepm` é provisório) e criar o app na Fly.
2. Criar os secrets: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `DATABASE_URL` e, se quiser, `CLERK_JWT_KEY`; para a IA, `ANTHROPIC_API_KEY` e `TYPESAFE_API_KEY`; para o GitHub, as cinco `GITHUB_APP_*`, quando existir o app de produção. Nunca `DATABASE_MIGRATION_URL`.
3. Rodar a primeira migração fora da Fly (ver a ordem acima).
4. Criar a instância de produção do Clerk para `treepm.ai`, com os registros DNS que ela exigir.
5. Apontar o DNS de `treepm.ai` para o app e emitir o certificado na Fly.
6. `fly deploy --build-arg VITE_CLERK_PUBLISHABLE_KEY=<chave pública de produção>`.
7. Conferir o cabeçalho de IP: de uma máquina só, mandar 130 requisições sem token a `/api/mcp/X` em menos de um minuto, cada uma com um `Fly-Client-IP` diferente e inventado. Se a 121ª em diante responder 429, o proxy sobrescreve o cabeçalho e está certo. Se nenhuma responder 429, o cliente consegue forjar o cabeçalho: tirar `CLIENT_IP_HEADER` do `fly.toml` e avisar a coordenação.
