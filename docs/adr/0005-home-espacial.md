# ADR 0005 — Home espacial, layout orbital e LOD

**Status:** Substituída pela [ADR 0013](0013-regioes-retangulares-uniformes.md)
**Data:** 2026-11-04

> Registro histórico da organização orbital. A decisão atual usa regiões retangulares uniformes com filhos abaixo do pai, conforme a ADR 0013.

## Contexto

Uma árvore profunda não cabe em cards completos na primeira viewport. Ao mesmo tempo, esconder ramos sem representação ou reduzir círculos sem reduzir os cards produz agregados incorretos e colisões. A home precisa comunicar hierarquia sem reproduzir a árvore top-down do legado.

## Decisão

A home usa constelações orbitais determinísticas, calculadas bottom-up por snapshot, sem arestas top-down. Cada geração é fisicamente menor. A normalização considera a altura da subárvore e aplica o mesmo fator a posições, larguras, alturas, raios e bounds. Os envelopes são recalculados com os retângulos reais; o anel separa o pai do envelope completo de cada ramo na direção angular.

A cena inicial apresenta root e filhos imediatos, com progresso e contagens agregadas. O LOD usa `full`, `compact`, `chip` e `dot`, além de agregados por status e indicadores dos filhos imediatos. A revelação considera a largura dos ancestrais e a viewport. Dots conservam a escala geométrica, sem um mínimo CSS que recrie overlaps.

Somente nós dentro da margem da viewport e cujos ancestrais estejam revelados entram no DOM. Agregados preservam acesso ao trabalho resumido, sem alterar tickets, `parentId` ou arestas.

## Consequências

A cena evita renderizar mil cards completos e mantém zero overlap geométrico; a validação com 1001 tickets cobriu todos os 500.500 pares do layout. O culling limita o DOM, mas não é a garantia de separação: a geometria já separa inclusive nós fora da viewport.

A alternativa de apenas ocultar cards sobrepostos foi rejeitada. Também se rejeitou texto minúsculo como substituto de zoom. Árvores arbitrariamente maiores ainda exigem avaliação de layout incremental e performance, registrada como trabalho futuro.
