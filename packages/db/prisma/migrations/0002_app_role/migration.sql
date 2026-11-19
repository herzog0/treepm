-- Papel de aplicação (ADR 0021). Criado por SQL: não é superusuário, não tem
-- BYPASSRLS e não é dono de tabela. NOLOGIN por padrão; em produção a
-- coordenação operacional habilita login e define a senha fora do Git
-- (ALTER ROLE treepm_app LOGIN PASSWORD ...). Os testes fazem isso no setup.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'treepm_app') THEN
    CREATE ROLE treepm_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA public TO treepm_app;

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  organizations, people, teams, team_memberships, areas,
  projects, project_teams, project_memberships
TO treepm_app;

-- Registro de atividade: a aplicação só insere e lê.
GRANT SELECT, INSERT ON TABLE activity_events TO treepm_app;

GRANT EXECUTE ON FUNCTION app_uuid_v7() TO treepm_app;
