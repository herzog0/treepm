# ADR 0006 — Câmera, gestos e alcance adaptativo de zoom

**Status:** Aceita
**Data:** 2026-11-04

## Contexto

O zoom precisa viajar da visão geral até qualquer folha sem perder o ponto sob o mouse. Limites fixos de 4× no foco e 6× no wheel tornavam isso impossível: a menor folha normalizada tinha aproximadamente 0,005944 px e permanecia dot ou desaparecia por culling. Apenas remover culling ou colocar texto nesse dot não a tornaria legível.

Depois, uma rajada de 120 deltas −1 revelou outra falha: cada evento reiniciava a animação de 180 ms a partir da câmera atual, descartando o alvo anterior. A sonda confirmou 120 eventos entregues e prevenidos, 119 cancelamentos de animação, zero long tasks e deslocamento exato para um único delta −120. Portanto, a causa era o reinício do easing, não perda de eventos nem render bloqueado.

## Decisão

- Zoom exponencial ancora o ponto mundial sob o cursor em todos os frames; pan usa threshold de 5 px. Na home, pode compor com wheel conforme a [ADR 0015](0015-pan-imediato-e-wheel-simultaneo.md).
- Clique simples abre detalhes sem mudar a câmera. **Explorar ramo** no painel e breadcrumb fazem o mergulho explícito, evitando a competição do duplo clique com o painel.
- O fit inicial centraliza `initialBounds`, para manter root e filhos retangulares na viewport, e deriva a escala da viewport. O fit comum de subárvore conserva máximo 4× quando ele é suficiente.
- A largura explícita de leitura é **140 px**. O máximo da câmera é `max(6, 140 / menorLarguraNormalizada)` para layouts válidos, recalculado por snapshot. No snapshot retangular original equivalia a aproximadamente **1.505,187×**; não há um teto absoluto menor que a necessidade de leitura.
- Foco calcula o fit da subárvore e a escala necessária para 140 px, usando a maior delas. Quando a leitura domina o fit, a câmera centraliza o próprio alvo, não o centro potencialmente assimétrico dos bounds.
- Wheel contínuo usa o mesmo máximo derivado e ganho moderado **0,0016** por unidade já normalizada por `deltaMode`. O alvo acumula todos os deltas em um único rAF. Cada frame aproxima a escala exibida do alvo em espaço logarítmico, com resposta exponencial de 55 ms, sem um easing que expire durante a rajada. Coordenadas iguais preservam a âncora; coordenadas novas capturam outra a partir da câmera visível sem perder o alvo acumulado. O loop só conclui após 180 ms ociosos e erro projetado inferior a 0,01 px. Fit e foco conservam seu easing próprio de 180 ms.
- Ao reduzir, os mesmos thresholds restauram `full → compact → dot` e agregados. Movimento reduzido aplica imediatamente o alvo acumulado. Valores não finitos em uma geometria degenerada usam fallback seguro de 6×.

## Consequências

Toda folha do layout atual pode ficar legível tanto por **Explorar ramo** quanto por wheel. No caso mais profundo verificado, a folha de depth 7 terminou `full`, com 140 px, título e metadados. O caminho de ancestrais continua sendo revelado pelo tamanho resultante, sem desativar o culling.

Com o novo ganho, 120 deltas −1 e um único −120 produziram a mesma razão **1,2117237×**, contra `exp(0,192) = 1,2116705×` dentro do arredondamento DOM. A sonda mediu 277 frames sem saltos e erro máximo de âncora de 0,00985 px; zoom-out retornou à escala inicial e reduced motion aplicou o mesmo deslocamento imediatamente.

Escalas muito altas deixam ancestrais fora da tela, o que é esperado; o alvo não pode ficar fora. O alcance depende de dimensões positivas e finitas. O ganho maior responde a rolagens curtas, mas a equivalência entre rajada e deslocamento agregado é garantida pelo acúmulo, não pelo aumento de sensibilidade isolado.

A revisão de continuidade reproduziu dois problemas com relógio de frames controlado: após 180 ms a interpolação passava a aplicar 100% de cada alvo; mover o cursor 1 px reiniciava a base e descartava deltas pendentes. A resposta passa a depender do frame exibido e do tempo desde o último frame, com alvo e âncora explicitamente separados. A regra anterior de pan aguardava a conclusão do wheel e consumia os movimentos ignorados atualizando a referência incremental. Essa espera foi substituída na home pela [ADR 0015](0015-pan-imediato-e-wheel-simultaneo.md), que permite assumir a câmera imediatamente e combinar os gestos. O harness de drag reproduziu 101 px de pan ao mover 1 px depois do wheel; a correção retoma exatamente o novo delta de 1 px.
