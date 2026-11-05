# ADR 0011 — Performance, índice derivado e renderização

**Status:** Aceita
**Data:** 2026-11-04

## Contexto

Agregar progresso e percorrer a árvore a cada card tornaria gestos caros. Porém, adotar workers, WebGL ou virtualização prematuramente complicaria acessibilidade e o modelo de cena. Home e legado têm gargalos diferentes e precisam de otimizações específicas.

## Decisão

`buildTreeIndex` deriva uma estrutura somente leitura por referência do array de tickets: mapas por ID e pai, filhos ordenados, profundidade, altura, contagens, folhas por status e progresso. Agregados são calculados em O(N), além da ordenação dos irmãos, e compartilhados entre home, legado e outras views.

A home calcula o layout por snapshot e limita o DOM por viewport e ancestrais revelados. No foco profundo, ancestrais enormes saem da viewport e o culling mantém poucos nós, mesmo com escala de câmera muito alta.

O legado usa `WeakMap`, memoização, caches CSSOM, escrita de geometria no rAF e fast path para atualizar nós persistentes sem recriar fibers. Cenas de destino são reutilizadas durante animações. A renderização continua em DOM/SVG, com `content-visibility` onde aplicável.

## Consequências

As otimizações reduzem trabalho repetido sem alterar regras de domínio nem reconciliação de agregados. DOM/SVG preserva texto, foco e controles acessíveis, mas não oferece garantia para árvores arbitrariamente grandes.

Não há workers, WebGL nem virtualização geral; Lista e Kanban continuam renderizando todos os tickets. Layout incremental, paginação e novos limites são futuros e dependem de medição, conforme `docs/open-questions.md`. Medições históricas locais não devem ser apresentadas como garantia de produção.
