# ADR 0013 — Regiões retangulares uniformes na home espacial

**Status:** Aceita
**Data:** 2026-11-04
**Substitui:** [ADR 0005](0005-home-espacial.md)

## Contexto

A organização orbital colocava filhos ao redor do pai, mas a direção de produto exigia filhos abaixo do pai e áreas retangulares delimitadas, sem transformar a home em um grid plano. A mudança precisava conservar normalização recursiva, zoom por geração, LOD, agregados e separação geométrica inclusive fora da viewport.

## Decisão

Cada pai organiza seus filhos por uma mesma geometria local:

- `ceil(sqrt(n))` colunas para `n` filhos, com linhas centralizadas e slots na ordem estável dos irmãos.
- Cada slot tem a largura e a altura do envelope completo da subárvore filha; gaps locais separam slots e linhas.
- Os cards dos filhos ficam alinhados ao topo de cada linha de slots, independentemente da altura de suas subárvores. A sobra vertical fica abaixo do ramo.
- A região dos filhos começa depois da borda inferior do card pai. O pai fica acima e centralizado sobre essa região.
- O cálculo continua bottom-up. A normalização por altura da subárvore reduz posições, dimensões e envelopes recursivamente, preservando gerações menores e uma experiência Prezi, não uma grade plana.
- Bounds dos pais reúnem o card próprio e os envelopes dos filhos. O fit inicial centraliza `initialBounds`, evitando que a segunda linha fique fora da tela.
- Contornos discretos e não interativos mostram os slots atrás dos cards, sem adicionar arestas top-down.

Como filhos começam abaixo do pai e slots/linhas são disjuntos, ramos irmãos não se intersectam. A recursão dessa propriedade garante que cards de diferentes gerações também não colidam. LOD, agregados e culling continuam independentes da integridade geométrica.

A apresentação começa com cards preenchidos pela cor de status. `c`/`C` alterna o preenchimento, com wash animado de cima para baixo e texto branco. O controle **Cores** expõe `aria-pressed`; modificadores, repeat e edição em inputs, textareas, selects ou contenteditable não disparam o atalho. Dots mantêm sua cor e agregados `mixed` continuam distintos.

## Consequências

A validação com 1001 tickets e profundidade 7 encontrou zero overlaps em todos os 500.500 pares, zero filhos fora da região abaixo do pai e zero violações de bounds. No desktop, root e seis ramos aparecem em duas linhas de três, todos legíveis e sem clipping.

O máximo de zoom continua derivado da menor largura normalizada. Na geometria atual é aproximadamente 1.505,187×, e a folha mais profunda continua alcançando 140 px/full por foco e por wheel. O valor é recalculado por snapshot, não fixado por esta ADR.

A ADR 0005 permanece como registro histórico da solução orbital. Layouts arbitrariamente maiores ainda exigem avaliação de densidade e performance; a regra `ceil(sqrt(n))` é uniforme, mas não promete uma composição editorial personalizada para cada família.
