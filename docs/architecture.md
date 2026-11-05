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

## Câmera e gestos

A escala máxima deriva de `max(6, 140 / menorLarguraNormalizada)`. O wheel normaliza `deltaMode`, acumula ganho exponencial de 0,0016 por unidade e conserva o ponto mundial sob o cursor. A aproximação ao alvo usa o tempo entre frames, em espaço logarítmico, com resposta de 55 ms; um único rAF continua suave em gestos longos.

Um pointerdown primário esquerdo ou do meio cancela a animação pendente na câmera exibida, sem salto nem cooldown. O threshold de 5 px distingue clique de drag. Durante drag, deltas incrementais atualizam a câmera imediatamente. Se houver wheel ativo, o mesmo delta translada sua âncora e recalcula o alvo, evitando que o próximo frame sobrescreva o pan.

Pointer capture é readquirido após perda com botão ainda pressionado. O click pós-drag é suprimido; ativação por teclado continua disponível. Movimento sem botão não acompanha a câmera. O mapa impede drag nativo e seleção acidental de texto.

Clique seleciona sem mover a câmera. Foco explícito enquadra o ramo ou centraliza o próprio alvo quando a leitura requer escala maior. Reset usa `initialBounds`. Movimento reduzido aplica os destinos imediatamente. C/Cores alterna preenchimento, com guards para edição, modificadores e repetição.

## Verificação

Usar typecheck, lint, build e diff check. Para mudanças de geometria e gestos, usar harnesses temporários no navegador: colisões e bounds, identidade durante morph, reversão, âncora, pan com wheel, captura, ausência de click acidental, movimento reduzido e telas estreitas. Remover os harnesses ao concluir.
