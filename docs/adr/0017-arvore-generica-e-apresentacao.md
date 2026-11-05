# ADR 0017 — Árvore genérica e apresentação substituível

**Status:** Aceita. **Data:** 2026-11-05.

## Contexto

A engine deve servir a consumidores que definem seus próprios tipos, incluindo o futuro TreePM, sem exigir campos de tickets ou conteúdo visual. O usuário também pediu substituir o badge `+N` por quadrados mesclados, com mistura de cores controlada por função.

## Decisão

`TreeNode` combina contratos mínimos de identidade e parentesco. Índice, layout e cena são genéricos e preservam os campos do consumidor sem casts de recuperação. O núcleo `@treepm/engine` é TypeScript puro, com opções tipadas para geometria, compressão, agrupamento e matemática da câmera.

`@treepm/react` integra a engine com DOM, gestos e acessibilidade. Adaptadores fornecem rótulos e cores; renderers e slots fornecem conteúdo; classes, tokens e stylesheet opcional fornecem estilo. A demo em `apps/web` é um consumidor com tipo e interface próprios.

Todos os filhos diretos participam de buckets contíguos e balanceados em até `maxSlots` slots. Um singleton representa seu nó; vários membros compartilham um quadrado mesclado. O grupo conserva IDs e identificação acessível, sem um contador visual `+N`. Crescimento e separação continuam reversíveis. Mistura de cores é uma função substituível da apresentação, não dado ou regra do índice.

## Consequências

Um produto pode usar apenas árvore/geometria ou escolher os componentes e estilos padrão. O TreePM futuro adicionará domínio, acesso, busca e serviços por fora dessas camadas. O blueprint em `docs/product-blueprint.md` planeja essa plataforma; esta decisão não autoriza sua implementação imediata.

A extração muda imports da demo e exige compilar a engine antes da biblioteca React e depois a aplicação. O workspace fornece esses comandos. Publicação externa e uma política de versionamento público ficam para uma decisão própria.
