# syntax=docker/dockerfile:1
# Imagem única do TreePM na Fly: a API NestJS serve o web estático (ADR 0022).
# Build local: docker build --build-arg VITE_CLERK_PUBLISHABLE_KEY=pk_... -t treepm .

ARG NODE_VERSION=22.23.1

# ---------- build: instala, gera o Prisma Client e compila todos os pacotes ----------
FROM node:${NODE_VERSION}-slim AS build
ENV CI=true
RUN corepack enable && corepack prepare pnpm@10.25.0 --activate
WORKDIR /repo

# Chave PÚBLICA do Clerk: o Vite a embute no bundle do web, então ela é argumento de
# build (não secret de runtime) e fica visível no navegador por definição. Nunca passe
# aqui a CLERK_SECRET_KEY nem qualquer outro segredo: ARGs ficam no histórico da imagem.
ARG VITE_CLERK_PUBLISHABLE_KEY
ENV VITE_CLERK_PUBLISHABLE_KEY=${VITE_CLERK_PUBLISHABLE_KEY}

COPY . .
RUN pnpm install --frozen-lockfile
RUN pnpm build
# Árvore enxuta da API: só dependências de produção; @treepm/db e @treepm/domain entram
# já compilados (o Prisma Client gerado vem no dist do db). O CLI do prisma e as
# migrações ficam de fora, e o pnpm ainda instala o CLI como peer do @prisma/client, então
# o CLI e suas dependências (só usadas por ele) são removidos do store, sem efeito em runtime: migrar é feito fora da Fly (ADR 0021, docs/deploy.md).
RUN pnpm --filter @treepm/api deploy --prod --legacy /out/api \
 && cd /out/api \
 && rm -rf src test vitest.config.ts tsconfig*.json \
 && rm -rf node_modules/@treepm/*/test node_modules/@treepm/*/vitest.config.ts \
           node_modules/@treepm/*/prisma node_modules/@treepm/*/prisma.config.ts \
           node_modules/@treepm/db/src node_modules/@treepm/*/tsconfig*.json \
           node_modules/@treepm/*/docker-compose.test.yml \
 && cd node_modules/.pnpm \
 && rm -rf prisma@* @prisma+studio-core* @prisma+dev@* @prisma+streams-local* \
           @prisma+query-plan-executor* @electric-sql+pglite* effect@* typescript@* elkjs@*

# ---------- runtime ----------
FROM node:${NODE_VERSION}-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/api /app
COPY --from=build --chown=node:node /repo/apps/web/dist /app/web
ENV WEB_DIST_DIR=/app/web
USER node
EXPOSE 4310
CMD ["node", "dist/main.js"]
