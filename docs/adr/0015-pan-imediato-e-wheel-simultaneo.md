# ADR 0015 — Pan imediato e wheel simultâneo na home

**Status:** Aceita
**Data:** 2026-11-04
**Complementa:** [ADR 0006](0006-camera-e-gestos.md)

## Contexto

A home bloqueava o início do arraste enquanto o wheel estava ativo ou dentro de um cooldown. Isso fazia o mapa ignorar movimentos logo depois do zoom e impedia navegar com drag e wheel juntos. A nova direção prioriza a resposta dos controles para uso intensivo.

## Decisão

Um novo pointerdown primário com botão esquerdo ou do meio assume a câmera exibida, cancelando qualquer animação de zoom ou enquadramento pendente. A câmera não salta até o alvo anterior e não há espera para iniciar pan. O threshold de 5 px distingue arraste de clique.

Se o usuário aplicar wheel durante o arraste, os gestos compõem. Cada pointermove aplica seu delta incremental à câmera imediatamente e translada as coordenadas de cursor da âncora do wheel pelo mesmo delta. O alvo é recalculado para a escala acumulada. Assim, os próximos frames de zoom acompanham o pan sem sobrescrevê-lo ou perder o ponto mundial agarrado. Ctrl/Meta não bloqueiam essa composição.

Pointerup/cancel encerra o drag. Lost pointer capture com botão pressionado conserva o estado e permite readquirir a captura no próximo movimento. O click pós-drag é suprimido, enquanto um click intencional ou ativação por teclado continua abrindo detalhes. O mapa impede seleção de texto e drag nativo de imagens durante a navegação.

A mudança vale para a home espacial. O legado mantém suas regras de prioridade do wheel e não compartilha o controlador de câmera da home.

## Consequências

Um novo gesto cancela explicitamente a cauda da animação anterior a partir do estado exibido; os deltas de uma nova sequência de wheel durante drag continuam acumulados. Pan não recebe easing adicional e não acumula movimento para aplicar depois.

O harness CDP temporário reproduziu o bloqueio anterior (0 px em vez de 40 × 30 px durante wheel). Após a mudança, pan e zoom simultâneos conservaram a âncora com erro máximo de 0,0022 px nos casos normal, Ctrl e Meta. Botão do meio, captura perdida/readquirida, click/seleção, controles da toolbar e movimento reduzido também passaram sem erros de console.
