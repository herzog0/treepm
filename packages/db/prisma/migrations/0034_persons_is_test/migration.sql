-- Pessoas de teste (ADR 0057; TREEPM-404). `is_test` marca a pessoa que existe só no banco do TreePM, sem usuário no Clerk, e que um
-- administrador pode "entrar como". É a base de um caminho em que uma requisição age em nome de outra pessoa, então a marca é
-- IMUTÁVEL: entra na inserção e nunca muda. Sem isso, um defeito qualquer na API transformaria uma pessoa de verdade em alvo de
-- "entrar como" (ou o contrário).
ALTER TABLE "people" ADD COLUMN "is_test" BOOLEAN NOT NULL DEFAULT false;

-- Até aqui o papel da aplicação tinha UPDATE na tabela inteira (migration 0002). Agora só nas colunas que a API muda: o upsert da
-- identidade (nome, e-mail, avatar, papel, ativa), a desativação de pessoa de teste e `updated_at` (o Prisma grava junto em toda
-- atualização). Ficam de fora a chave (`org_id`, `id`), `clerk_user_id`, `created_at` e `is_test`. INSERT, SELECT e DELETE ficam como estavam.
REVOKE UPDATE ON TABLE people FROM treepm_app;
GRANT UPDATE (display_name, email, avatar_url, clerk_role, active, updated_at) ON TABLE people TO treepm_app;

-- O banco amarra a marca ao prefixo e ao papel (revisão 1): pessoa de teste TEM o identificador sintético e é `member`; quem tem o
-- identificador sintético É de teste. Assim nem um caminho novo de gravação cria pessoa de teste administradora, nem pessoa de
-- verdade com cara de teste (ou o contrário). O prefixo é o de `TEST_PERSON_PREFIX` na API.
ALTER TABLE "people" ADD CONSTRAINT "people_is_test_prefix_check" CHECK (is_test = starts_with(clerk_user_id, 'treepm_test_'));
ALTER TABLE "people" ADD CONSTRAINT "people_is_test_member_check" CHECK (NOT is_test OR clerk_role = 'member');

-- Rastro de quem agiu: um comentário escrito agindo como outra pessoa guarda `via = 'act-as'` e a pessoa de verdade (como o MCP guarda
-- `via = 'mcp'`). Os dois campos andam juntos, nunca mudam depois (o UPDATE continua só nas colunas que já tinha) e a leitura pública
-- não os devolve.
ALTER TABLE "ticket_comments" DROP CONSTRAINT "ticket_comments_via_check";
ALTER TABLE "ticket_comments" ADD COLUMN "via_person_id" UUID;
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_via_check" CHECK (via IS NULL OR via IN ('mcp', 'act-as'));
ALTER TABLE "ticket_comments" ADD CONSTRAINT "ticket_comments_via_person_check" CHECK ((COALESCE(via, '') = 'act-as') = (via_person_id IS NOT NULL));
