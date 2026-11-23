-- Segunda barreira contra ciclo na árvore de tickets (ADR 0045, TREEPM-30): um UPDATE que muda `parent_id` é recusado se o novo pai
-- é o próprio ticket ou um descendente dele. A primeira barreira é a trava de estrutura por projeto na API; este gatilho cobre quem
-- escreve fora dela (script, SQL manual, defeito). Custo: sobe de pai em pai pela chave primária, proporcional à profundidade e não ao
-- tamanho da árvore. Só no UPDATE de `parent_id`: um ticket recém-inserido não tem descendentes, então o INSERT não pode fechar ciclo.
-- Esta migration só adiciona uma função e um gatilho (sem coluna nova): a API de antes continua funcionando com ela aplicada.
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
    IF hops > 100000 THEN
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
