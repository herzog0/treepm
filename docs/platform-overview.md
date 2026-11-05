# TreePM — base atual

O workspace contém dois pacotes: uma engine espacial pura e uma demo React. A decisão de reiniciar a implementação está em [ADR 0016](adr/0016-engine-espacial-isolada.md); a intenção de produto permanece em [vision.md](vision.md).

## Engine

`@treepm/engine` recebe uma lista de `SpatialItem`, composta por `id`, `parentId`, `label` e `color`. O índice calcula relações, profundidades e contagens da hierarquia. O layout organiza gerações em regiões retangulares menores, com filhos abaixo do pai e cards alinhados ao topo das suas linhas.

A projeção produz uma representação por nó: indicador ou card. A transformação de posição e tamanho é uma função contínua do zoom. A cena inclui grupos explícitos quando há muitos filhos e limita a renderização à viewport. A matemática da câmera mantém a âncora do cursor e suaviza o alvo acumulado do wheel.

## Demo

`apps/web` carrega os dados fictícios locais e renderiza a cena. A camada React contém câmera, pointer capture, seleção, foco explícito, breadcrumb, cores e controles. O fundo espacial e os gestos fazem parte desta base.

Uma nova interação assume a câmera exibida imediatamente. Durante drag, o pan translada a câmera e a âncora do wheel juntos. Soltar o ponteiro encerra o drag, sem iniciar movimentos automáticos de acompanhamento.

## Desenvolvimento

`pnpm dev` acompanha engine e demo. `pnpm build` produz a biblioteca ESM e o site estático. `pnpm typecheck`, `pnpm lint` e `git diff --check` são as verificações de conclusão.

Detalhes em [architecture.md](architecture.md). Ideias futuras em [ideas.yaml](ideas.yaml).
