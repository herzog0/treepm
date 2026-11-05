# ADR 0014 — Continuidade entre indicador e ticket

**Status:** Aceita
**Data:** 2026-11-04
**Complementa:** [ADR 0013](0013-regioes-retangulares-uniformes.md)

## Contexto

Os quadradinhos abaixo de um card representam seus filhos diretos. Exibi-los junto dos tickets já revelados duplicava a representação. Um fade independente ao revelar os tickets também perdia a ligação visual entre cada quadradinho e seu destino.

## Decisão

A home usa uma única representação por ID de ticket, calculada em `spatialScene.ts` a partir do layout, da câmera e do índice compartilhado. Com pouco zoom, essa representação é um quadrado de até 6 px sob o pai. Ao aproximar, sua posição e suas dimensões evoluem até o retângulo do ticket no layout espacial. O mesmo elemento React/DOM permanece durante a passagem individual; o corpo não desaparece por opacidade.

A transformação acompanha a escala da câmera, sem um segundo relógio de animação. O movimento vertical separa as linhas antes do deslocamento horizontal e do crescimento, evitando cruzamentos de ramos. Reverter o zoom percorre a mesma geometria em sentido inverso. Pan e culling não iniciam viagens artificiais a partir dos indicadores.

Cada geração revela os próprios filhos conforme o espaço disponível. Os filhos seguintes surgem como indicadores sob o ticket recém-revelado. A largura de revelação considera a proporção entre pai e filhos para preservar o alcance legível de todas as folhas. Os estados full/compact/chip/dot, as cores derivadas e o layout retangular continuam independentes do domínio.

Indicadores não são alvos de edição nem entradas adicionais na contagem de tickets abertos. Famílias que não cabem usam um grupo `+N`, com contagem e rótulo acessível explícitos. A quantidade de slots permanece estável e a linha se ajusta por escala contínua; o grupo encolhe enquanto os corpos adicionais crescem a partir de tamanho zero. Prévias de ramos muito pequenos perdem visibilidade progressivamente antes de sair da cena, sem um limite de largura que remova quadrados opacos de uma vez. A seleção continua vinculada ao ID do ticket mesmo quando sua representação é resumida. Movimento reduzido aplica a nova geometria imediatamente pelo comportamento da câmera.

## Consequências

A cena fica determinística por câmera e não mantém filas de entrada/saída ou animações temporais pendentes para corpos de tickets. O culling usa os retângulos apresentados, incluindo posições intermediárias, para não remover um quadradinho antes de ele chegar ao destino. Conteúdo textual mantém sua transição de LOD separada.

As regras de zoom semântico e `WheelAnchor` do legado permanecem próprias de `/legacy`.
