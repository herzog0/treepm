# Arquitetura da engine espacial

## Fronteiras

`packages/engine` é TypeScript ESM puro, sem React ou conceitos de negócio. `apps/web` integra a engine com o navegador e contém uma demonstração com dados locais. O HTML final é estático e não depende de serviços.

A entrada é uma lista de `SpatialItem`: identificador estável, pai opcional, rótulo e cor. A ordem de entrada define a ordem dos irmãos. `buildSpatialIndex` valida a estrutura e deriva mapas por ID, filhos, profundidade, altura e contagens das subárvores.

## Layout

`buildSpatialLayout` mede as subárvores bottom-up. Cada pai usa `ceil(sqrt(n))` colunas, linhas centralizadas e slots que contêm os envelopes completos dos filhos. O topo dos cards coincide com o topo da linha de slots. Filhos ficam abaixo do pai e os envelopes são disjuntos.

A normalização reduz posições, dimensões e bounds pelo mesmo fator; gerações menores continuam fisicamente menores. O layout fornece um mapa por ID, bounds por ramo e `initialBounds` para enquadramento. Não há dependência de layout de grafo externo.

## Cena e níveis de detalhe

`buildSpatialScene` projeta o layout com a câmera atual. Cada nó tem uma representação por ID: indicador ou card. O progresso de revelação depende da largura projetada do pai; deslocamento vertical, deslocamento horizontal e crescimento seguem curvas contínuas e reversíveis.

Os níveis full/compact/chip/dot controlam o conteúdo apresentado. Uma linha estável de até oito indicadores e um grupo `+N` se adapta à largura por escala contínua. O grupo encolhe enquanto os representantes adicionais crescem a partir de tamanho zero. Prévias de ramos muito pequenos perdem visibilidade antes do culling, evitando cortes opacos.

O culling usa os retângulos apresentados, inclusive durante a transição. A renderização usa superfícies locais de pelo menos 6 px escaladas até o tamanho real para que bordas CSS não imponham mínimos visuais a elementos subpixel. Cores são atributos visuais da entrada; não representam regras de domínio.

Layout e índice são snapshots imutáveis, com fronteiras públicas `readonly`. A cena prepara limiares, referências e offsets uma vez por par de snapshots, em um cache com chaves fracas. Alterações de entrada exigem reconstruir os snapshots. Cálculos de expansão e morph são compartilhados pelos irmãos em cada frame; arrays públicos de grupos não expõem o cache.

Na web, a cena é projetada sem a translação da câmera. A origem opcional `x/y` da viewport desloca apenas o culling; um container aplica a translação visual. Assim, pan preserva as props geométricas dos nós existentes e permite o bailout do React. Conteúdo semântico e botão são memoizados; mudanças de LOD usam animação CSS sem espera por timers. Variáveis de morph ficam locais à superfície e sombras menores acompanham os LODs pequenos.

## Câmera e gestos

A escala máxima deriva de `max(6, 140 / menorLarguraNormalizada)`. O wheel normaliza `deltaMode`, acumula ganho exponencial de 0,0016 por unidade e conserva o ponto mundial sob o cursor. A aproximação ao alvo usa o tempo entre frames, em espaço logarítmico, com constante de resposta de 32 ms; um único rAF continua suave em gestos longos. Ao restarem menos de 0,05 px relativos à viewport, aplica o alvo exato e encerra o loop. O retângulo do stage é reaproveitado entre eventos, invalidado por resize, scroll e novo pointerdown, evitando leituras síncronas de layout durante o wheel.

Um pointerdown primário esquerdo ou do meio cancela a animação pendente na câmera exibida, sem salto nem cooldown. O threshold de 5 px distingue clique de drag. Durante drag, deltas incrementais atualizam a câmera imediatamente. Se houver wheel ativo, o mesmo delta translada sua âncora e recalcula o alvo, evitando que o próximo frame sobrescreva o pan.

Pointer capture é readquirido após perda com botão ainda pressionado. O click pós-drag é suprimido; ativação por teclado continua disponível. Movimento sem botão não acompanha a câmera. O mapa impede drag nativo e seleção acidental de texto.

Clique seleciona sem mover a câmera. Foco explícito enquadra o ramo ou centraliza o próprio alvo quando a leitura requer escala maior. Reset usa `initialBounds`. Movimento reduzido aplica os destinos imediatamente. C/Cores alterna preenchimento, com guards para edição, modificadores e repetição.

## Verificação

Usar typecheck, lint, build e diff check. Para mudanças de geometria e gestos, usar harnesses temporários no navegador: colisões e bounds, identidade durante morph, reversão, âncora, pan com wheel, captura, ausência de click acidental, movimento reduzido e telas estreitas. Remover os harnesses ao concluir.

Na otimização de 2026-11-05, o probe de 1.760 projeções da demo de 1.001 nós passou de 612,5 ms para 69,7–92,1 ms no Chrome local. O cálculo preservou a saída anterior em 5.728 comparações exatas; 5.340 casos adicionais validaram a translação da viewport, com diferença máxima de posição de 2,9e-12 px. A resposta matemática a um passo de zoom atingiu 90% em 83,3 ms, contra 133,3 ms antes, com amostragem de 60 Hz. Os gestos no navegador mantiveram erro de âncora inferior a 0,002 px e leitura de 140 px/full nas 746 folhas.

Esses ganhos não equivalem a uma garantia de 60 fps. No percurso de 220 frames, com até 327 nós visíveis, a build compilada teve mediana de 16,7 ms, p95 de 26,2 ms e máximo de 43,5 ms no Chrome headless local. O modo de desenvolvimento teve p95 de 42,9 ms. O cenário de pan isolado teve p95 de 16,8 ms; os trechos mais densos de zoom ainda concentram custo de layout e pintura.
