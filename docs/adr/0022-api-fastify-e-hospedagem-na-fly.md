# ADR 0022 — API em Node na Fly.io, mesma origem do web

**Status:** Aceita no que foi decidido por Teodoro na issue #1 em 2026-11-19 (Fly.io, runtime Node em contêiner, domínio `treepm.ai`). Os itens da seção "Propostas a confirmar" aguardam resposta. **Data:** 2026-11-19.

## Contexto

A Fase 1 precisa de um servidor que verifique a sessão do Clerk, abra a transação com o tenant (ADR 0021) e exponha os comandos de organização, times, áreas e projetos. Hoje só existe a SPA `apps/web`. Conferido na documentação do Clerk em 2026-11-19: o pacote `@clerk/fastify` lê `CLERK_PUBLISHABLE_KEY` e `CLERK_SECRET_KEY`, registra `clerkPlugin` e expõe `getAuth(request)` com `userId`, `orgId`, `orgRole`, `sessionStatus` e `has()`. A documentação recomenda fortemente definir `authorizedParties` com as origens aceitas e permite verificação sem rede com `jwtKey` (`CLERK_JWT_KEY`).

## Decisão

1. **Hospedagem.** Fly.io, em contêiner Node 22. Não há runtime edge.
2. **Fronteira.** A API vive em `apps/api` e fala HTTP+JSON. `packages/engine` e `packages/react` continuam sem conhecer API, tenant ou Clerk. Regras de domínio que não dependem de HTTP ficam em um pacote próprio (`packages/domain`), testável sem servidor.
3. **Autenticação.** Toda rota de produto exige sessão ativa com organização ativa: sem sessão, 401; com sessão pendente ou sem organização, 403. `orgId` e `userId` vêm só de `getAuth`. `authorizedParties` é sempre definido a partir de configuração (`APP_ORIGIN`).
4. **Provisionamento.** O primeiro acesso autenticado cria ou reconcilia os registros locais de organização e pessoa dentro da transação do tenant. Webhooks do Clerk ficam para uma ADR posterior.
5. **Segredos.** `CLERK_SECRET_KEY`, `DATABASE_URL` e `DATABASE_MIGRATION_URL` ficam nos secrets da Fly e em `.env.local` de desenvolvimento, nunca no Git. `VITE_CLERK_PUBLISHABLE_KEY` é embutida no build do web: na Fly é argumento de build, não secret de runtime.
6. **Deploy.** Dockerfile e `fly.toml` ficam no repositório. Publicar continua exigindo autorização explícita de Teodoro, porque a Fly gera custo.

## Propostas a confirmar

- **Framework:** Fastify 5 com `@clerk/fastify` e validação de entrada com Zod. Era a combinação da API anterior (checkpoint `33c4702`) e é a que a documentação do Clerk cobre para Node.
- **Topologia: uma origem.** Um único app na Fly atende `treepm.ai`: a API em `/api/*` e os arquivos estáticos do web no restante. Sem CORS, `authorizedParties` com uma origem só, um DNS e um app a pagar. Em desenvolvimento, o Vite encaminha `/api` para a API local. A alternativa (web e API em apps e subdomínios separados) só se justifica quando precisarem escalar de forma independente.
- **Região:** `gru` (São Paulo), junto do Neon em `aws-sa-east-1`.
- **Produção do Clerk:** instância de produção no domínio `treepm.ai`, com os registros DNS que o Clerk exigir. Só é necessária no primeiro deploy público.

## Consequências

- A topologia de uma origem simplifica segurança e custo, mas acopla o deploy do web ao da API.
- Sem webhooks, mudanças feitas no painel do Clerk (remoção de membro, por exemplo) só se refletem no próximo acesso; a revogação continua efetiva porque o token deixa de trazer a organização.
