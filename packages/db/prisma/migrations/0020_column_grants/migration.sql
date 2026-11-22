-- Concessão por coluna em `access_tokens` e `organizations` (TREEPM-196, pendência da revisão de segurança do MCP com escrita).
-- Até aqui o papel da aplicação tinha UPDATE na tabela inteira (migrations 0002 e 0012); o alcance do token (`scope`), o resumo
-- do segredo, a pessoa, o projeto e a validade nunca mudam depois de criados, mas só o código garantia isso. Agora o banco garante.
-- Mesmo modelo de `ticket_comments` (migration 0015). SELECT, INSERT e DELETE de `access_tokens` ficam como estavam.

-- A API só atualiza `access_tokens` para revogar (`revoked_at`) e registrar o último uso (`last_used_at`); `updated_at` é o
-- que o Prisma grava junto em toda atualização.
REVOKE UPDATE ON TABLE access_tokens FROM treepm_app;
GRANT UPDATE (revoked_at, last_used_at, updated_at) ON TABLE access_tokens TO treepm_app;

-- A API só atualiza `organizations` para o upsert da identidade (`name`, `slug`), as duas chaves do MCP (`mcp_enabled`,
-- `mcp_write_enabled`) e `updated_at`. Ficam de fora a chave primária (`org_id`, de que todo o isolamento depende) e `created_at`.
REVOKE UPDATE ON TABLE organizations FROM treepm_app;
GRANT UPDATE (name, slug, mcp_enabled, mcp_write_enabled, updated_at) ON TABLE organizations TO treepm_app;
