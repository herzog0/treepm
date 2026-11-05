# ADR 0003 — Tickets, responsáveis e progresso derivado

**Status:** Aceita
**Data:** 2026-11-04

## Contexto

Uma árvore de trabalho precisa representar tanto tarefas executáveis quanto agrupadores. Permitir status manual em pais criaria divergência entre o estado declarado e o trabalho real das folhas. Também é necessário atribuir trabalho a várias pessoas e separar componentes sem transformar componentes em tickets.

## Decisão

`Ticket` contém identidade, projeto, sequência, `parentId`, título, descrição, status, `assigneeIds`, componentes e timestamps. Cada `TicketComponent` tem nome livre e seus próprios `assigneeIds`; a API valida IDs e duplicidades.

Somente folhas aceitam edição manual de `todo`, `in_progress` ou `done`. Um pai apresenta progresso derivado de todas as folhas descendentes:

- `doneLeaves` e `totalLeaves`;
- percentual arredondado;
- `not_started`, `active` ou `done`;
- rótulo textual com concluídas, total e percentual.

Uma folha é sua própria unidade de cálculo. Um ramo sem folhas apresenta “Sem folhas”. O agregado do projeto usa todas as folhas, inclusive em florestas.

Cor nunca é o único canal. Na apresentação, folhas homogêneas preservam sua categoria visual; combinações usam `mixed`/laranja, acompanhadas de contagens, tooltip ou texto. Isso não altera `Ticket.status` nem as regras puras de progresso.

## Consequências

Editar status de um pai retorna `409 PARENT_STATUS_DERIVED`. Quebrar uma tarefa muda a quantidade de folhas e, portanto, o peso relativo do trabalho: nesta fatia todas as folhas têm peso igual.

Ponderação por estimativa/esforço e o conceito de “bloqueado” permanecem futuros, registrados em `docs/open-questions.md`. Não se deve inferir progresso por status armazenado em um pai ou por cor isolada.
