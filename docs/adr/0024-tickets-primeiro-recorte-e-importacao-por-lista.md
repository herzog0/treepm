# ADR 0024 — Tickets: primeiro recorte e importação por lista

**Status:** Aceita. **Data:** 2026-11-19. **A [ADR 0034](0034-um-so-tipo-de-ticket-das-folhas-para-o-topo.md), de 2026-11-21, muda um ponto:** o ticket com filhos passa a ter situação própria.

## Contexto

Teodoro decidiu em 2026-11-19 que o TreePM passa a controlar o próprio projeto do TreePM. Para isso o produto precisa de tickets, que são a Fase 2 do [blueprint](../product-blueprint.md).

Esta ADR define **um recorte** da Fase 2: o mínimo para registrar e acompanhar trabalho em árvore. Ela não cumpre a condição de saída da Fase 2 (uma entrega real atravessando duas áreas), porque contribuições por área, comentários e histórico visível ficam para ADRs seguintes.

A sessão coordenadora não tem sessão do Clerk e não cria dados na conta de ninguém. As tarefas reais do projeto entram por uma importação de lista feita pelo próprio usuário na interface. Essa importação é uma lista colada, não é a importação de trackers da IDEA-010.

A aparência das telas de ticket depende da ADR de design (a seguinte). Esta ADR fixa dados, regras e contratos, que não dependem de aparência.

## Decisão

### Dados

Toda tabela nova segue a [ADR 0021](0021-neon-postgres-e-rls-por-organizacao.md): `org_id`, RLS forçado, chave primária `(org_id, id)`, UUID v7, `created_at` e `updated_at`.

| Tabela | Campos próprios | Regras |
| --- | --- | --- |
| `projects` (alterada) | `next_ticket_number integer not null default 1` | Contador do número do próximo ticket do projeto. |
| `tickets` | `id`, `project_id`, `number`, `parent_id` (opcional), `title`, `description`, `status`, `created_by_person_id` | `(org_id, project_id, number)` é único. `title` tem de 1 a 200 caracteres depois de aparar espaços. `description` é texto simples, de 0 a 20.000 caracteres. `status` é `todo`, `in_progress`, `in_review`, `done` ou `cancelled`, com `todo` como padrão. |
| `ticket_assignees` | `ticket_id`, `person_id` | Uma linha por par. Um ticket aceita várias pessoas; não existe dono único. |

- O identificador visível é `<key do projeto>-<number>`, por exemplo `TREE-12`. O número é alocado na mesma transação que cria o ticket, com a linha do projeto travada, e nunca é reutilizado.
- O pai é do mesmo projeto, e o banco garante isso: a chave estrangeira do pai é `(org_id, project_id, parent_id)` contra `(org_id, project_id, id)`. Um projeto pode ter várias raízes (`parent_id` nulo).
- Remover um ticket com filhos é recusado pelo banco (`on delete restrict`).

### Ordem dos irmãos

Os irmãos aparecem em ordem crescente de `number`, que é a ordem de criação. A engine usa a ordem de entrada, então a listagem já sai nessa ordem. Reordenar irmãos fica fora deste recorte.

### Situação e progresso

A [ADR 0031](0031-agrupadores.md) troca "ticket com filhos" por um tipo declarado, o agrupador: só agrupador tem filhos, e é ele que não tem situação e traz progresso, mesmo vazio.

O blueprint já define a regra, e esta ADR a aplica:

- Só folha tem situação manual. Um ticket com filhos não tem situação de execução: a API devolve `status: null` para ele e recusa alterar a situação com 409 `ticket_has_children`.
- Quando uma folha ganha o primeiro filho, a situação guardada é preservada no banco e volta a valer se o ticket voltar a ser folha.
- Um ticket com filhos traz `progress: { done, total, excluded }`, calculado sobre as **folhas descendentes**: `excluded` conta as canceladas, `total` conta as demais e `done` conta as concluídas. Folha traz `progress: null`. A interface sempre mostra o progresso com a base, por exemplo `3 de 8 concluídos`.
- O cálculo é uma função pura em `packages/domain`.

### Parentesco

- Mudar o pai é um `PATCH` com `parentId` (ou `null` para virar raiz).
- Um ticket não pode ser pai de si mesmo nem de um ancestral: 409 `ticket_cycle`.
- Pai de outro projeto ou inexistente: 404.
- Mover ticket entre projetos fica fora deste recorte.

### Permissões

Vale o que a Fase 1 já definiu em [domain-model.md](../domain-model.md): a decisão é do servidor, em `packages/domain`.

| Ação | Admin da organização | Gestor | Colaborador | Leitor | Membro sem papel |
| --- | --- | --- | --- | --- | --- |
| Ver tickets de projeto `organization` | sim | sim | sim | sim | sim |
| Ver tickets de projeto `private` | sim | sim | sim | sim | não |
| Criar, editar, mudar situação, mudar pai, atribuir pessoas, importar lista | sim | sim | sim | não | não |
| Remover ticket | sim | sim | não | não | não |

- Administrador de time não ganha nada sobre tickets por esse papel.
- Toda rota de ticket, inclusive a busca pelo ID do ticket, devolve 404 quando o projeto é privado e o chamador não o vê. 403 só aparece para projeto visível sem permissão.
- Projeto arquivado é só leitura: qualquer mutação de ticket devolve 409 `project_archived`.
- Só se remove ticket sem filhos: com filhos, 409 `ticket_has_children`.
- Atribuir alguém não concede acesso. A pessoa atribuída precisa estar ativa (409 `person_inactive`) e já enxergar o projeto (409 `person_without_project_access`). Se ela perder o acesso depois, a atribuição continua registrada.

### Eventos de atividade

Toda mutação grava um `activity_event` na mesma transação: `ticket.created`, `ticket.updated` (com os campos alterados), `ticket.deleted`, `ticket.assignee_added` e `ticket.assignee_removed`. A importação grava **um** evento `ticket.imported` por lote, com o projeto como assunto e `{ count, firstNumber, lastNumber }` no payload.

### API (prefixo `/api`)

| Método e caminho | Uso |
| --- | --- |
| `GET /projects/:projectId/tickets` | Todos os tickets do projeto, em ordem de `number`, sem descrição. |
| `POST /projects/:projectId/tickets` | Cria um ticket. |
| `POST /projects/:projectId/tickets/import` | Cria uma árvore de tickets de uma vez. |
| `GET /tickets/:id` | Detalhe, com descrição. |
| `PATCH /tickets/:id` | Altera título, descrição, situação ou pai. |
| `DELETE /tickets/:id` | Remove um ticket sem filhos. |
| `PUT /tickets/:id/assignees/:personId` | Atribui uma pessoa. Idempotente. |
| `DELETE /tickets/:id/assignees/:personId` | Remove a atribuição. |

Formas, seguindo as convenções da Fase 1 (`POST` 201, `PUT` 200 com corpo, `DELETE` 204, corpo com campo desconhecido 400):

```ts
type TicketStatus = "todo" | "in_progress" | "in_review" | "done" | "cancelled";

/** Item da listagem. Não traz descrição: listagem e detalhe carregam separados. */
type TicketSummary = {
  id: string;
  projectId: string;
  number: number;
  key: string; // "TREE-12"
  parentId: string | null;
  title: string;
  status: TicketStatus | null; // null quando tem filhos
  progress: { done: number; total: number; excluded: number } | null; // null em folha
  assigneeIds: string[]; // ordenados
};

type TicketDetail = TicketSummary & {
  description: string;
  createdByPersonId: string;
  createdAt: string;
  updatedAt: string;
};

// GET /projects/:projectId/tickets -> TicketSummary[]
// POST /projects/:projectId/tickets
type CreateTicketBody = {
  title: string;
  description?: string;
  parentId?: string | null;
  status?: TicketStatus;
  assigneeIds?: string[];
}; // -> 201 TicketDetail

// PATCH /tickets/:id (ao menos um campo)
type UpdateTicketBody = {
  title?: string;
  description?: string;
  status?: TicketStatus;
  parentId?: string | null;
}; // -> TicketDetail

// PUT /tickets/:id/assignees/:personId -> TicketDetail

// POST /projects/:projectId/tickets/import
type ImportItem = {
  title: string;
  description?: string;
  status?: TicketStatus;
  children?: ImportItem[];
};
type ImportTicketsBody = { parentId?: string | null; items: ImportItem[] };
// -> 201 TicketSummary[] (os criados, em ordem de number)
```

A importação é atômica: um item inválido devolve 400 e nada é criado. Os números são alocados em pré-ordem (pai antes dos filhos, irmãos na ordem recebida). Limites: de 1 a 500 itens no total e profundidade máxima de 20. `status` em item com filhos é aceito e fica guardado, como em qualquer ticket com filhos.

A listagem não é paginada neste recorte. O mapa pede os tickets de cada projeto visível e não arquivado, uma requisição por projeto.

### Formato da lista colada

A API recebe a árvore em JSON. O texto colado é interpretado na web por uma função pura, de modo que o formato pode evoluir sem mudar a API. O formato é uma lista de tarefas em Markdown:

```text
- Fechamento da Fase 1
  Texto livre abaixo do item vira a descrição.
  Pode ter mais de uma linha.
  - [x] Tarefa concluída
  - [/] Tarefa em andamento
  - [r] Tarefa em revisão
  - [-] Tarefa cancelada
  - [ ] Tarefa a fazer
  - Tarefa sem marcador (a fazer)
```

- Um item é uma linha que, depois da indentação, começa com `- ` ou `* `. A indentação conta em espaços, e uma tabulação vale dois.
- O pai de um item é o item anterior mais próximo com indentação menor. Itens sem pai são raízes da importação.
- O marcador é opcional: `[ ]` a fazer, `[/]` em andamento, `[r]` em revisão, `[x]` ou `[X]` concluído, `[-]` cancelado. Sem marcador, a fazer.
- Uma linha que não é item e tem indentação maior que a do item anterior é descrição dele. As linhas são unidas com quebra de linha, sem a indentação comum. Linhas em branco entre linhas de descrição são mantidas; as demais linhas em branco são ignoradas.
- Erros apontam a linha: texto antes do primeiro item, linha solta com indentação menor ou igual à do item anterior, título vazio ou acima de 200 caracteres, mais de 500 itens, profundidade acima de 20.
- A interface mostra a prévia da árvore antes de enviar e avisa que marcador em item com filhos não aparece, porque ticket com filhos não tem situação.

### Web

- `apps/web/src/api/client.ts` ganha os métodos de ticket, com as respostas validadas como as demais.
- `buildMapItems` passa a receber os tickets: cada ticket é um nó cujo pai é o ticket pai ou, na raiz, o projeto.
- O interpretador da lista fica em `apps/web/src/tickets/`.
- Componentes visuais (card do ticket em cada nível de detalhe, painel do ticket, tela de importação) esperam a ADR de design.

## Fora deste recorte

Contribuições por área, critérios de aceite, comentários, histórico visível, relações cruzadas, prioridade e prazo, reordenação de irmãos, mover entre projetos, arquivar ticket, busca, paginação, tempo real e importação de trackers (IDEA-010).

## Consequências

- O TreePM passa a ter trabalho real nos próprios dados, com um modelo de ticket menor que o do blueprint. As contribuições por área entram depois como tabelas novas ligadas ao ticket, sem mudar o que esta ADR cria.
- Sem paginação, um projeto muito grande devolve tudo em uma resposta, e o mapa faz uma requisição por projeto. Serve para o uso inicial; volumes maiores pedem um endpoint único ou carga por região.
- O progresso é calculado a cada listagem, sem valor guardado. É simples e sempre correto; o custo cresce com o tamanho do projeto.
- A importação por lista cria tickets sem vínculo com uma origem externa. Reimportar a mesma lista duplica os tickets.
- A regra de acesso do atribuído impede atribuir quem não vê um projeto privado, o que obriga a conceder o papel antes.
