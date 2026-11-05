# ADR 0012 — Segurança, configuração e estratégia de validação

**Status:** Aceita
**Data:** 2026-11-04

## Contexto

A fatia local precisa de comandos reproduzíveis e verificação real sem fingir autenticação, credenciais ou uma suíte que ainda não foi adotada. Variáveis públicas e segredos devem permanecer separados.

## Decisão

A API escuta por padrão em `127.0.0.1:3001`; web usa `5173` e admin `5174`. CORS aceita somente esses frontends locais em `localhost`/`127.0.0.1`. `HOST` pode alterar o bind explicitamente. `PORT`, `LOG_LEVEL` e `TREEPM_DATA_FILE` configuram a API; `VITE_API_URL` define a URL pública da API nos frontends.

`TYPESAFE_API_KEY` pertence somente à API. Segredos não são documentados nem copiados de `.env`; `apps/api/.env.example` é a referência sem valores secretos.

Comandos oficiais:

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm build
```

Também são válidos `pnpm --filter @treepm/api dev`, `@treepm/web dev` e `@treepm/admin dev` para trabalho isolado.

A convenção atual não adota suíte automatizada permanente. As mudanças passam por lint, typecheck, build, `git diff --check`, endpoints reais quando pertinente e harnesses CDP temporários para browser, gestos, rotas, mobile, console e `getBoundingClientRect()`. O harness `.tmp-deep-zoom-repro.mjs` foi usado na revisão da folha profunda e removido após a validação pelo Master, não uma suíte committed.

## Consequências

A validação exercita a entrega real, inclusive API e renderização, em vez de apenas imports. Artefatos temporários são removidos pelos autores, sem apagar dados do usuário nem interromper processos que já estavam em uso.

Não há autenticação, autorização nem proteção de produção. Publicar API ou backoffice exige auth, política de rede, banco transacional e revisão de segredos. A ausência de suíte é uma decisão desta etapa, não uma afirmação de que testes permanentes sejam indesejáveis no futuro.
