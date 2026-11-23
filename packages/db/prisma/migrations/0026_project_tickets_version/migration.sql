-- Versão da lista de tickets do projeto (ADR 0046, TREEPM-246, revisão 2). Um contador sem relógio: o toque do fim da transação
-- faz `tickets_version = tickets_version + 1`. Substitui `projects.updated_at` como versão: aquele campo é gravado pelo Prisma com
-- o relógio de cada instância da API, e relógios diferentes podiam fazer a versão recuar.
ALTER TABLE projects ADD COLUMN tickets_version bigint NOT NULL DEFAULT 0;
