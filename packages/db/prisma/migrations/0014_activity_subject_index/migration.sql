-- Histórico do ticket (ADR 0040, fatia 1): ler os eventos de um assunto sem percorrer os da organização inteira.

-- CreateIndex
CREATE INDEX "activity_events_org_id_subject_type_subject_id_occurred_at_idx" ON "activity_events"("org_id", "subject_type", "subject_id", "occurred_at");
