# ADR 0019 — Organização do Clerk como tenant e papéis no domínio

**Status:** Aceita (aprovada por Teodoro na issue #1 em 2026-11-19, com os limites do Hobby aceitos para o piloto). **Data:** 2026-11-19.

## Contexto

Teodoro decidiu que o provedor de identidade é o Clerk, no plano Hobby, e que o produto é multitenant desde o primeiro dia. Ainda não existem API nem banco; hoje só há `apps/web`, uma SPA Vite sem roteador.

Conferido em clerk.com/pricing e na documentação em 2026-11-19: o Hobby inclui Organizations com 100 organizações retidas por mês, no máximo 20 membros por organização (padrão 5) e apenas os papéis `org:admin` e `org:member`. Papéis personalizados em produção exigem o add-on Enhanced B2B (US$ 100/mês). MFA exige o plano Pro. O token de sessão na versão 2 traz a organização ativa no claim `o` (`id`, `slg`, `rol`, `per`), presente só quando há organização ativa. Abas diferentes podem ter organizações ativas diferentes.

## Decisão

1. **Tenant.** Um tenant é uma Clerk Organization. A instância exige membership (sem contas pessoais): toda sessão de produto tem uma organização ativa.
2. **Origem do `org_id`.** O servidor obtém usuário e organização somente do token de sessão verificado pelo SDK do Clerk (`sub` e `o.id`). Um ID de organização vindo de URL, corpo, cabeçalho próprio ou estado do navegador nunca concede acesso. O navegador obtém o token com `getToken()` a cada chamada, para respeitar a organização da aba.
3. **Isolamento.** Toda entidade de produto e todo job, evento, cache, anexo e índice carrega `org_id`. Toda consulta filtra por ele na camada de dados, e relações validam o tenant dos dois lados. A escolha do banco e do mecanismo que impõe o filtro (por exemplo, políticas por linha) fica para uma ADR própria; esta ADR fixa o contrato.
4. **Papéis.** O Clerk guarda só `admin` e `member`. Os demais papéis do blueprint são dados do domínio, por time ou projeto, avaliados no servidor. A Fase 1 não depende de permissões personalizadas do Clerk (`o.per`).
5. **Web.** `apps/web` usa `@clerk/react` com a chave pública em `VITE_CLERK_PUBLISHABLE_KEY`. Como não há roteador, "rota protegida" é um portão em torno do app: sem sessão, tela de entrada; com sessão e sem organização ativa, escolha ou criação de organização; com organização ativa, o mapa. Trocar de organização descarta o estado derivado do tenant anterior. Um roteador só entra, com ADR, quando houver mais de uma tela.
6. **Demo sem login.** A demo local com dados fictícios continua acessível pelo caminho explícito `?demo`, sem carregar o Clerk, porque as verificações de geometria dependem dela. Sem chave e sem `?demo`, o app mostra um erro de configuração; não há fallback silencioso.
7. **Engine.** `packages/engine` e `packages/react` não importam Clerk nem conhecem tenant.

## Matriz mínima da Fase 1

| Ação | Admin da organização (`o.rol = admin`) | Membro (`o.rol = member`) | Sem organização ativa |
| --- | --- | --- | --- |
| Entrar, criar e trocar de organização | sim | sim | só criar ou escolher |
| Convidar e remover pessoas, mudar papel Clerk | sim | não | não |
| Criar times, áreas e projetos | sim | não | não |
| Conceder papel de domínio (admin de time, gestor de projeto, colaborador, leitor) | sim | só onde for gestor do projeto ou admin do time | não |
| Ver e editar um projeto | sim | conforme o papel de domínio no projeto | não |

Ser membro da organização não dá acesso a todos os projetos; o acesso por projeto vem do papel de domínio. Convidado externo é um membro Clerk com papel de domínio `leitor` em projetos explícitos.

## Consequências

- O RBAC do blueprint cabe no Hobby sem o add-on, ao custo de manter papéis de time e projeto no nosso banco.
- Valem os limites de 20 pessoas por organização e ausência de MFA até uma mudança de plano.
- Provisionamento não espera webhook: o primeiro acesso autenticado cria ou reconcilia os registros locais de organização e pessoa. Webhooks servem para reconciliar depois.
- Ficam para ADRs seguintes: banco e imposição do filtro por tenant, framework da API, roteador e sincronização por webhook.
