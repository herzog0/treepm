# TreePM — base atual

O workspace contém uma engine TypeScript pura, uma biblioteca React opcional e uma demo consumidora. A decisão de reiniciar a implementação está em [ADR 0016](adr/0016-engine-espacial-isolada.md); a separação reutilizável está em [ADR 0017](adr/0017-arvore-generica-e-apresentacao.md). A intenção de produto permanece em [vision.md](vision.md); o [business blueprint](product-blueprint.md) planeja a plataforma futura sem implementá-la.

## Engine

`@treepm/engine` recebe uma lista de um tipo genérico que estende `TreeNode`, composto apenas por `id` e `parentId`. O índice preserva esse tipo e calcula relações, profundidades e contagens. Opções tipadas parametrizam layout, cena e matemática da câmera. O layout organiza gerações em regiões retangulares menores, com filhos abaixo do pai e cards alinhados ao topo das suas linhas.

A projeção produz indicadores, cards e grupos com membership explícito. Filhos são particionados em slots balanceados, sem badge `+N`. A transformação de posição e tamanho é contínua e a renderização limita-se à viewport. A matemática da câmera mantém a âncora do cursor e suaviza o alvo acumulado do wheel.

## Apresentação opcional

`@treepm/react` fornece componentes e hooks tipados, seleção, comandos de foco, gestos, acessibilidade e mistura de cores substituível. Conteúdo por LOD, adaptadores, slots, classes e tokens podem ser definidos pelo consumidor. O stylesheet é uma importação opt-in. Exemplos em [engine-usage.md](engine-usage.md).

## Demo

`apps/web` define seu próprio tipo com rótulo, cor e campos adicionais, carrega dados fictícios e consome a biblioteca. Breadcrumb, contagens técnicas e painel da demo são composição local, não exigências da engine.

Uma nova interação assume a câmera exibida imediatamente. Durante drag, o pan translada a câmera e a âncora do wheel juntos. Soltar o ponteiro encerra o drag, sem iniciar movimentos automáticos de acompanhamento.

## Desenvolvimento

`pnpm dev` acompanha engine, biblioteca React e demo. `pnpm build` produz as bibliotecas ESM com declarações e o site estático. `pnpm typecheck`, `pnpm lint` e `git diff --check` são as verificações de conclusão.

Detalhes em [architecture.md](architecture.md). Ideias futuras em [ideas.yaml](ideas.yaml).
