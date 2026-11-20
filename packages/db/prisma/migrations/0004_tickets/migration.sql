-- Tickets (ADR 0024): contador por projeto, tickets em árvore e atribuições.

-- AlterTable
ALTER TABLE "projects" ADD COLUMN "next_ticket_number" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "tickets" (
    "org_id" TEXT NOT NULL,
    "id" UUID NOT NULL DEFAULT app_uuid_v7(),
    "project_id" UUID NOT NULL,
    "number" INTEGER NOT NULL,
    "parent_id" UUID,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'todo',
    "created_by_person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tickets_pkey" PRIMARY KEY ("org_id","id"),
    CONSTRAINT "tickets_status_check" CHECK ("status" IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
    CONSTRAINT "tickets_title_check" CHECK (char_length(btrim("title")) BETWEEN 1 AND 200),
    CONSTRAINT "tickets_description_check" CHECK (char_length("description") <= 20000),
    CONSTRAINT "tickets_number_check" CHECK ("number" >= 1)
);

-- CreateTable
CREATE TABLE "ticket_assignees" (
    "org_id" TEXT NOT NULL,
    "ticket_id" UUID NOT NULL,
    "person_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ticket_assignees_pkey" PRIMARY KEY ("org_id","ticket_id","person_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tickets_org_id_project_id_id_key" ON "tickets"("org_id", "project_id", "id");

-- CreateIndex
CREATE UNIQUE INDEX "tickets_org_id_project_id_number_key" ON "tickets"("org_id", "project_id", "number");

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_project_id_fkey" FOREIGN KEY ("org_id", "project_id") REFERENCES "projects"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey (o pai é do mesmo projeto: garantido pelo banco)
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_project_id_parent_id_fkey" FOREIGN KEY ("org_id", "project_id", "parent_id") REFERENCES "tickets"("org_id", "project_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_org_id_created_by_person_id_fkey" FOREIGN KEY ("org_id", "created_by_person_id") REFERENCES "people"("org_id", "id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("org_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_org_id_ticket_id_fkey" FOREIGN KEY ("org_id", "ticket_id") REFERENCES "tickets"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ticket_assignees" ADD CONSTRAINT "ticket_assignees_org_id_person_id_fkey" FOREIGN KEY ("org_id", "person_id") REFERENCES "people"("org_id", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Isolamento por organização (ADR 0021), idêntico às demais tabelas.
ALTER TABLE tickets ENABLE ROW LEVEL SECURITY;
ALTER TABLE tickets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tickets
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

ALTER TABLE ticket_assignees ENABLE ROW LEVEL SECURITY;
ALTER TABLE ticket_assignees FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ticket_assignees
  USING (org_id = current_setting('app.org_id', true))
  WITH CHECK (org_id = current_setting('app.org_id', true));

GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE tickets, ticket_assignees TO treepm_app;
