-- Terceiro alcance do MCP, "pessoas e conversas" (ADR 0062, fatia 2; TREEPM-494). Só acrescenta; nenhuma linha existente muda.
-- Atenção à ordem de publicação: o caminho da sessão e o do token passam a ler `mcp_people_enabled` e `people`, então esta migration
-- precisa estar aplicada antes do código novo.
--
-- Terceira chave da organização, "Pessoas e conversas": desligada por padrão; só um administrador liga (o código só a deixa ligar
-- com `mcp_enabled` ligada). Sem ela, nenhum token entrega nome de pessoa.
ALTER TABLE "organizations" ADD COLUMN "mcp_people_enabled" BOOLEAN NOT NULL DEFAULT false;

-- Alcance do token: INDEPENDENTE de leitura/escrita (`scope`). Os tokens que já existem ficam sem ele, e ele não muda depois de
-- criado: a concessão de UPDATE de `access_tokens` é por coluna (migration 0020) e esta coluna fica fora dela, como o `scope`.
ALTER TABLE "access_tokens" ADD COLUMN "people" BOOLEAN NOT NULL DEFAULT false;

-- O papel da aplicação passa a poder atualizar a nova chave da organização (a concessão de UPDATE é por coluna).
GRANT UPDATE (mcp_people_enabled) ON TABLE organizations TO treepm_app;
