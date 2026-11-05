# ADR 0004 — Hierarquia versus dependências

**Status:** Aceita
**Data:** 2026-11-04

## Contexto

Pai/filho e dependência são relações semanticamente diferentes. Representar ambas apenas por `parentId` impediria ciclos válidos de organização, conexões cruzadas de trabalho e estilos independentes. A API também precisa evitar órfãos e ciclos dirigidos de dependência.

## Decisão

`TicketEdge` possui identidade, projeto, origem, destino, `type: hierarchy | dependency`, estilo e metadados próprios. Cor, espessura e tracejado são editáveis por aresta; selecionar ou estilizar uma não altera outra.

- Hierarquia é definida por `Ticket.parentId`. Criar ou reparentar um ticket sincroniza suas arestas `hierarchy` na API.
- Uma aresta hierárquica não pode ser removida isoladamente; é necessário alterar o pai.
- Dependências são criadas e removidas sem mudar `parentId`.
- Dependências pertencem ao mesmo projeto, não podem duplicar origem/destino, formar self-loop nem criar caminho dirigido de retorno à origem.
- Excluir tickets remove todas as arestas incidentes, evitando referências órfãs.

As regras puras de validação de pai e ciclo ficam em `packages/domain`; a aplicação obrigatória das regras ocorre nas mutações da API.

## Consequências

A home espacial pode omitir arestas top-down sem perder a hierarquia persistida. O legado apresenta hierarquia e dependências com identidade e estilo independentes.

Nesta fatia, dependências comunicam relação, mas não bloqueiam iniciar ou concluir uma folha. Semântica de impedimento, dependências entre projetos e histórico de relações são questões futuras, não comportamento implementado.
