# ADR 0022 — API NestJS na Fly.io, mesma origem do web

**Status:** Aceita. Fly.io, Node e domínio decididos por Teodoro na issue #1; NestJS com Zod, topologia de uma origem e região decididos por ele na sessão de coordenação, tudo em 2026-11-19. **Data:** 2026-11-19.

## Contexto

A Fase 1 precisa de um servidor que verifique a sessão do Clerk, abra a transação com o tenant (ADR 0021) e exponha os comandos de organização, times, áreas e projetos. Hoje só existe a SPA `apps/web`. Conferido na documentação do Clerk em 2026-11-19: os SDKs de servidor leem `CLERK_PUBLISHABLE_KEY` e `CLERK_SECRET_KEY` e expõem um objeto de autenticação com `userId`, `orgId`, `orgRole`, `sessionStatus` e `has()`. O Clerk não foi conferido quanto a um pacote específico para NestJS; a integração usa o SDK de servidor do Clerk dentro de um guard. A documentação recomenda fortemente definir `authorizedParties` com as origens aceitas e permite verificação sem rede com `jwtKey` (`CLERK_JWT_KEY`).

## Decisão

1. **Hospedagem.** Fly.io, em contêiner Node 22. Não há runtime edge.
2. **Fronteira.** A API vive em `apps/api` e fala HTTP+JSON. `packages/engine` e `packages/react` continuam sem conhecer API, tenant ou Clerk. Regras de domínio que não dependem de HTTP ficam em um pacote próprio (`packages/domain`), testável sem servidor.
3. **Autenticação.** Toda rota de produto exige sessão ativa com organização ativa: sem sessão, 401; com sessão pendente ou sem organização, 403. `orgId` e `userId` vêm só do objeto de autenticação do SDK do Clerk, obtido em um guard global. `authorizedParties` é sempre definido a partir de configuração (`APP_ORIGIN`).
4. **Provisionamento.** O primeiro acesso autenticado cria ou reconcilia os registros locais de organização e pessoa dentro da transação do tenant. Webhooks do Clerk ficam para uma ADR posterior.
5. **Segredos.** `CLERK_SECRET_KEY`, `DATABASE_URL` e `DATABASE_MIGRATION_URL` ficam nos secrets da Fly e em `.env.local` de desenvolvimento, nunca no Git. `VITE_CLERK_PUBLISHABLE_KEY` é embutida no build do web: na Fly é argumento de build, não secret de runtime.
6. **Deploy.** Dockerfile e `fly.toml` ficam no repositório. Publicar continua exigindo autorização explícita de Teodoro, porque a Fly gera custo.

## Framework, topologia e região

- **Framework:** NestJS, com validação de entrada e saída em Zod. A autenticação é um guard global; o contexto do tenant e a transação da ADR 0021 ficam em um interceptor ou provider de escopo de requisição, de modo que um controller não consiga consultar o banco sem eles.
- **Topologia: uma origem.** Um único app na Fly atende `treepm.ai`: a API em `/api/*` e os arquivos estáticos do web no restante. Sem CORS, `authorizedParties` com uma origem só, um DNS e um app a pagar. Em desenvolvimento, o Vite encaminha `/api` para a API local.
- **Região:** `gru` (São Paulo), junto do Neon. Preços lidos em fly.io/pricing em 2026-11-19: a menor máquina sempre ligada (shared-cpu-1x, 256 MB) custa US$ 3,54 por mês em `gru` contra US$ 2,19 em `iad`, e o tráfego de saída custa US$ 0,04 por GB contra US$ 0,02. A Fly não tem plano gratuito, mas dispensa faturas mensais abaixo de US$ 5 em organizações pessoais. Teodoro pediu a região mais barata, salvo diferença mínima; a diferença de cerca de US$ 1,35 por mês foi tratada como mínima.
- **Produção do Clerk:** instância de produção no domínio `treepm.ai`, com os registros DNS que o Clerk exigir. Só é necessária no primeiro deploy público.

## Consequências

- A topologia de uma origem simplifica segurança e custo, mas acopla o deploy do web ao da API.
- Sem webhooks, mudanças feitas no painel do Clerk (remoção de membro, por exemplo) só se refletem no próximo acesso; a revogação continua efetiva porque o token deixa de trazer a organização.
