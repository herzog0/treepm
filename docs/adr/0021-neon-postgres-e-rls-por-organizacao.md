# ADR 0021 — Neon PostgreSQL e isolamento por organização com RLS

**Status:** Aceita. Neon, PostgreSQL e RLS decididos por Teodoro na issue #1; Prisma, região e política de testes decididos por ele na sessão de coordenação, tudo em 2026-11-19. **Data:** 2026-11-19.

## Contexto

A ADR 0019 fixou o contrato: todo dado de produto carrega `org_id` e o servidor só o obtém do token verificado. Falta o mecanismo que impõe o filtro. Uma política por linha (RLS) só isola se a aplicação não puder contorná-la, e há três formas conhecidas de isso falhar em silêncio. Conferido na documentação do Neon em 2026-11-19:

- Papéis criados pelo Console, pela API ou pela CLI do Neon são administradores (`neon_superuser`) e têm `BYPASSRLS`. Papéis criados por SQL (`CREATE ROLE`) não entram em `neon_superuser` e recebem só os privilégios básicos do schema `public`.
- No PostgreSQL, o dono da tabela ignora as políticas, a menos que a tabela use `FORCE ROW LEVEL SECURITY`.
- O endpoint com pool do Neon é um PgBouncer em modo transação: `SET` de sessão não é suportado, e a documentação recomenda `SET LOCAL` dentro de uma transação. Migrações devem usar a conexão direta.

## Decisão

1. **Banco.** PostgreSQL gerenciado no Neon. Branches do Neon podem servir a ambientes de preview.
2. **Dois papéis, duas conexões.**
   - `DATABASE_MIGRATION_URL`: papel dono criado pelo Neon, conexão direta. Usado só por migrações. Nunca é configurado no processo da API.
   - `DATABASE_URL`: papel `treepm_app`, criado por SQL em uma migração, sem `BYPASSRLS`, sem `neon_superuser` e sem ser dono de tabela; recebe apenas `SELECT`, `INSERT`, `UPDATE` e `DELETE` nas tabelas de produto. Conexão com pool (`-pooler`). É a única conexão da API.
3. **Tabelas de tenant.** Toda tabela de produto tem `org_id text not null` (o ID da Clerk Organization), `ENABLE` e `FORCE ROW LEVEL SECURITY`, e uma política única:
   `USING (org_id = current_setting('app.org_id', true)) WITH CHECK (org_id = current_setting('app.org_id', true))`.
4. **Contexto por requisição.** Cada requisição autenticada roda em uma transação. A primeira instrução é `select set_config('app.org_id', $1, true)` (equivalente parametrizável de `SET LOCAL`), com o `orgId` vindo do token verificado; `app.user_id` segue o mesmo caminho. Não existe consulta de produto fora dessa transação.
5. **Falha fechada.** Sem `app.org_id`, `current_setting(..., true)` devolve nulo: leituras retornam zero linhas e escritas são rejeitadas pela política.
6. **Relações.** Chaves estrangeiras entre tabelas de tenant são compostas com `org_id`, para o banco recusar uma relação entre organizações.
7. **Tabelas sem tenant.** Só as de infraestrutura (controle de migrações). Qualquer outra exceção exige ADR.
8. **Neon Data API / RLS por JWT não é usado.** A documentação o apresenta para consultas feitas do cliente por HTTP; aqui o navegador nunca fala com o banco, e a API já verifica o token com o SDK do Clerk.

## Verificação obrigatória

Um teste automatizado conecta como `treepm_app` e demonstra: com organização A no contexto, não lê nem altera linhas da organização B, nem insere linha com `org_id` de B; sem contexto, não lê nada e não escreve. O mesmo teste executado com o papel dono não prova nada e não conta. Essa verificação é a condição de saída da Fase 1 ("casos negativos de acesso entre tenants").

## Acesso a dados, região e testes

- **Prisma** é a camada de acesso a dados e de migrações. As migrações são SQL versionado no repositório; papéis, `GRANT`, `FORCE ROW LEVEL SECURITY` e políticas são escritos à mão nesses arquivos, porque o schema do Prisma não os descreve. A aplicação usa a conexão com pool e as migrações usam a direta. O contexto do tenant é aplicado em uma transação interativa por requisição; nenhum acesso ao cliente Prisma acontece fora dela.
- **Região:** Neon `aws-sa-east-1` (São Paulo). O plano Free do Neon tem o mesmo preço em qualquer região, e a diferença na Fly é pequena (ADR 0022).
- **Testes:** o projeto trabalha com TDD. A suíte é permanente, com Vitest, e os testes de isolamento rodam contra um PostgreSQL em contêiner Docker próprio, em porta dedicada, sem tocar em bancos de outros projetos.

## Consequências

- Um erro de consulta na API não vaza dados entre organizações, porque o filtro está no banco.
- Toda rota paga uma transação, e trabalho em segundo plano precisa declarar o tenant da mesma forma.
- Operações administrativas entre tenants (suporte, exportação global) não existem até haver uma ADR própria.
