# ADR 0007 — Legado, zoom semântico e protótipos DEV

**Status:** Aceita
**Data:** 2026-11-04

## Contexto

A experiência top-down já possuía regras avançadas de compactação e navegação que não devem ser misturadas com a home espacial. Também existem protótipos de avaliação visual que não podem ser confundidos com views de produção.

## Decisão

`/legacy` mantém árvore semântica DOM/SVG, Lista, Kanban, detalhes, formulários e conexões. A compactação é bottom-up por `subtreeHeight`: folhas reduzem antes dos pais, em `full → compact → chip → dot → agregado`, com contagens reconciliadas e indicadores imediatos acessíveis.

`WheelAnchor` preserva tipo, ticket, presença do nó, razão relativa, referência local, cena e fallbacks durante uma sessão de coordenadas estáveis. Retomadas partem da cena visível; decisões usam `anchor.ticketId`, não um hit acidental do DOM. Pan, settle, pointer capture, foco explícito, movimento reduzido e `Ctrl`/`Meta` seguem as regras documentadas em `docs/architecture.md`.

Somente em desenvolvimento, `/legacy?variant=A`, `B`, `C` e `D` abrem referências em `components/prototypes/`. A direção A está integrada à avaliação semântica; C e D permanecem explorações, não views de produção. Essas rotas não alteram dados.

## Consequências

A home espacial não importa `useSemanticGestures` nem `semanticScene`; domínio, API, bootstrap e `TreeIndex` continuam compartilhados. Isso evita acoplar duas máquinas de cena distintas.

Pinch dedicado, FLIP com Web Animations API e promoção de C/D não estão implementados. A avaliação histórica e possíveis evoluções ficam em `docs/semantic-zoom-proposal.md`, sem transformar protótipos em compromissos de produto.
