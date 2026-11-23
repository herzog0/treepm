-- Defesa no banco contra ciclo na árvore de tickets (ADR 0045, TREEPM-30). A primeira barreira é a trava de estrutura por projeto na API;
-- esta migration cobre quem escreve fora dela (script, SQL manual, defeito) com duas peças:
--  1. CHECK `parent_id <> id`: o ticket não pode ser pai de si mesmo, no INSERT (com id explícito) e no UPDATE.
--  2. Gatilho em `UPDATE OF parent_id`: recusa um pai novo que seja o próprio ticket ou um descendente dele, subindo de pai em pai
--     pela chave primária (custo proporcional à profundidade, não ao tamanho da árvore).
-- O que NÃO cobre: o INSERT não tem gatilho (um ticket comum recém-inserido não tem descendentes), mas com ids explícitos um par mútuo
-- (A pai de B e B pai de A) ou um ciclo mais longo inserido no mesmo comando passa, porque a chave estrangeira só é conferida no fim do
-- comando; o CHECK só pega o auto-pai. Também não pega a corrida entre duas transações (cada uma só vê dados confirmados): isso é a
-- trava da API. Não há coluna nova: a API de antes continua funcionando com esta migration aplicada.
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_parent_not_self" CHECK ("parent_id" IS NULL OR "parent_id" <> "id") NOT VALID;
ALTER TABLE "tickets" VALIDATE CONSTRAINT "tickets_parent_not_self";

-- Limite de saltos: nenhuma árvore real tem 10 000 níveis; o limite só existe para o caso de já haver um ciclo acima do pai novo (que
-- nunca passa por NEW.id), quando o laço rodaria sem fim. 10 000 buscas pela chave primária terminam em milissegundos.
CREATE FUNCTION tickets_reject_parent_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  walker uuid := NEW.parent_id;
  hops integer := 0;
BEGIN
  WHILE walker IS NOT NULL LOOP
    IF walker = NEW.id THEN
      RAISE EXCEPTION 'ticket_parent_cycle: o pai escolhido é o próprio ticket ou um descendente dele' USING ERRCODE = '23514';
    END IF;
    hops := hops + 1;
    IF hops > 10000 THEN
      RAISE EXCEPTION 'ticket_parent_cycle: árvore profunda demais ou já com ciclo' USING ERRCODE = '23514';
    END IF;
    SELECT t.parent_id INTO walker FROM tickets t WHERE t.org_id = NEW.org_id AND t.id = walker;
  END LOOP;
  RETURN NEW;
END $$;

CREATE TRIGGER tickets_no_parent_cycle
BEFORE UPDATE OF parent_id ON "tickets"
FOR EACH ROW
WHEN (NEW.parent_id IS NOT NULL AND NEW.parent_id IS DISTINCT FROM OLD.parent_id)
EXECUTE FUNCTION tickets_reject_parent_cycle();
