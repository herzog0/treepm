-- A situação de um pai sai dos filhos (ADR 0068, seção 2; TREEPM-568). Só refaz dados: nenhuma estrutura muda.
-- Um ticket com pelo menos um filho que não é ideia tem a situação calculada pela tabela da ADR: todos cancelados → cancelled;
-- todos concluídos ou cancelados, com pelo menos um concluído → done; algum em andamento, em revisão ou concluído, com filho
-- ainda aberto → in_progress; os demais → todo. Ideias ficam de fora como no progresso: o filho raiz de ideia não conta, e a raiz
-- de ideia e o que está dentro dela não são calculados (a situação ali fica parada até o aceite, ADR 0042).
-- De baixo para cima: cada volta refaz todos os pais a partir da situação de agora dos filhos; a volta seguinte vê o que a
-- anterior gravou, então a altura da árvore em voltas basta, e o laço para na primeira volta sem mudança.
-- Isolamento por organização (ADR 0021): pai e filhos são ligados sempre pela mesma organização e pelo mesmo projeto. Roda pelo
-- papel dono, como toda migração (ver 0044).
-- Pai que passa a concluído ou cancelado perde o marcador de trabalho pela IA, como na conclusão à mão (o CHECK
-- `tickets_agent_work_not_finished_check` recusaria o contrário). A versão do projeto (ADR 0046) anda uma vez em cada projeto
-- onde algum pai mudou, para a lista de quem já está com a tela aberta ser lida de novo. Sem eventos de atividade: é a regra nova
-- aplicada ao que existe, não uma mudança feita por alguém.
DO $$
DECLARE
  changed integer;
  touched uuid[] := '{}';
  round integer := 0;
BEGIN
  LOOP
    round := round + 1;
    IF round > 10000 THEN
      RAISE EXCEPTION 'situação dos pais não convergiu em % voltas', round - 1;
    END IF;
    WITH RECURSIVE in_idea AS (
      SELECT org_id, project_id, id FROM tickets WHERE idea_stage IS NOT NULL
      UNION
      SELECT t.org_id, t.project_id, t.id
        FROM tickets t JOIN in_idea i ON t.org_id = i.org_id AND t.project_id = i.project_id AND t.parent_id = i.id
    ), kids AS (
      SELECT c.org_id, c.project_id, c.parent_id AS id,
             bool_and(c.status = 'cancelled') AS all_cancelled,
             bool_and(c.status IN ('done', 'cancelled')) AS all_finished,
             bool_or(c.status IN ('in_progress', 'in_review', 'done')) AS any_started
        FROM tickets c
       WHERE c.parent_id IS NOT NULL AND c.idea_stage IS NULL
       GROUP BY c.org_id, c.project_id, c.parent_id
    ), derived AS (
      SELECT k.org_id, k.project_id, k.id,
             CASE WHEN k.all_cancelled THEN 'cancelled'
                  WHEN k.all_finished THEN 'done'
                  WHEN k.any_started THEN 'in_progress'
                  ELSE 'todo' END AS status
        FROM kids k
       WHERE NOT EXISTS (SELECT 1 FROM in_idea i WHERE i.org_id = k.org_id AND i.project_id = k.project_id AND i.id = k.id)
    ), updated AS (
      UPDATE tickets t
         SET status = d.status,
             agent_work_started_at = CASE WHEN d.status IN ('done', 'cancelled') THEN NULL ELSE t.agent_work_started_at END,
             agent_work_until = CASE WHEN d.status IN ('done', 'cancelled') THEN NULL ELSE t.agent_work_until END,
             agent_work_person_id = CASE WHEN d.status IN ('done', 'cancelled') THEN NULL ELSE t.agent_work_person_id END,
             agent_work_note = CASE WHEN d.status IN ('done', 'cancelled') THEN NULL ELSE t.agent_work_note END,
             updated_at = now()
        FROM derived d
       WHERE t.org_id = d.org_id AND t.project_id = d.project_id AND t.id = d.id AND t.status <> d.status
      RETURNING t.project_id
    )
    SELECT count(*)::integer, touched || coalesce(array_agg(DISTINCT project_id), '{}') INTO changed, touched FROM updated;
    EXIT WHEN changed = 0;
  END LOOP;
  UPDATE projects SET tickets_version = tickets_version + 1 WHERE id = ANY (SELECT DISTINCT unnest(touched));
END $$;
