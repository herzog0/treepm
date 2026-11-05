# Arquitetura da engine espacial

## Fronteiras

`packages/engine` é TypeScript ESM puro, sem React ou conceitos de negócio. `packages/react` integra a engine com DOM e apresentação opcional; `apps/web` é uma demonstração consumidora com dados locais. O HTML final é estático e não depende de serviços.

A entrada é uma lista de `TNode extends TreeNode`. `TreeNode` combina `TreeNodeIdentity` e `TreeNodeHierarchy`, com `id` e `parentId`, sem rótulo ou cor obrigatórios. A ordem de entrada define os irmãos. `buildTreeIndex` valida a estrutura e deriva mapas por ID, filhos, profundidade, altura e contagens. O tipo concreto é preservado no índice, layout e cena. Os nomes espaciais antigos são aliases de migração, sem lógica duplicada.

## Layout

`buildSpatialLayout` mede as subárvores bottom-up. Cada pai usa `ceil(sqrt(n))` colunas, linhas centralizadas e slots que contêm os envelopes completos dos filhos. O topo dos cards coincide com o topo da linha de slots. Filhos ficam abaixo do pai e os envelopes são disjuntos.

A normalização reduz posições, dimensões e bounds pelo mesmo fator; os defaults mantêm gerações fisicamente menores. Dimensões podem vir de sequência por geração ou callback tipado; gaps e normalização são opções. O layout fornece um mapa por ID, bounds por ramo e `initialBounds`. Não há dependência de layout de grafo externo.

## Cena e níveis de detalhe

`buildSpatialScene` projeta o layout com a câmera atual. Cada nó tem uma representação por ID: indicador ou card. O progresso de revelação depende da largura projetada do pai; deslocamento vertical, deslocamento horizontal e crescimento seguem curvas contínuas e reversíveis.

Os níveis full/compact/chip/dot controlam o conteúdo apresentado. Todos os filhos diretos são particionados em até `maxSlots` buckets contíguos e balanceados. Singletons mantêm um representante próprio; buckets maiores têm um quadrado mesclado, sem badge `+N`. Seus membros se separam e crescem a partir do slot enquanto o grupo encolhe. Membership preserva a contagem acessível. Prévias muito pequenas perdem visibilidade antes do culling. Limiares, intervalos de morph, slots e margem de culling são opções tipadas.

O culling usa os retângulos apresentados, inclusive durante a transição. A apresentação usa superfícies locais positivas escaladas até o tamanho real para que bordas CSS não imponham mínimos a elementos subpixel. Cores e rótulos vêm de adaptadores do consumidor. Mistura é callback substituível da apresentação; o padrão faz média ponderada em RGB linearizado e retorna sRGB. A engine conhece apenas IDs e geometria dos membros.

Layout e índice são snapshots imutáveis, com fronteiras públicas `readonly`. A cena prepara limiares, referências e offsets por par de snapshots e valores normalizados das opções, em um cache com chaves fracas para os snapshots. Alterações de entrada exigem reconstruí-los. Cálculos de expansão e morph são compartilhados pelos irmãos em cada frame; membership de grupos é readonly e estável, permitindo memoizar mistura e rótulos.

Na biblioteca React, a cena é projetada sem a translação da câmera. A origem opcional `x/y` da viewport desloca apenas o culling; um container aplica a translação visual. Assim, pan preserva props geométricas e permite o bailout do React. Conteúdo e botão são memoizados; LOD usa animação CSS sem timers. Variáveis de morph ficam locais à superfície e sombras menores acompanham os LODs pequenos.

`useSpatialCanvas` expõe estado e comandos tipados; `SpatialCanvasView` fornece DOM e slots, e `SpatialCanvas` combina ambos. Conteúdo por LOD, labels acessíveis, controles, cores, mistura e temas são substituíveis. O CSS é importação opt-in e o consumidor fornece altura do container. A demo mantém breadcrumb, métricas e painel próprios. Exemplos em [engine-usage.md](engine-usage.md).

A geometria animada tem ownership separado da semântica React: refs tipadas registram somente os hosts presentes em cada instância, e um layout effect do `SpatialCanvasView` aplica as propriedades geométricas do commit atual antes da pintura. O markup inicial conserva uma seed imutável para SSR. Os componentes comparam todas as props semânticas, inclusive callbacks, exceto a seed privada usada só na montagem. Assim, frames exclusivamente geométricos não executam os componentes internos. Detach invalida o registro e seu snapshot; não há cache global de DOM, queries de layout ou rAF adicional. A preferência de movimento reduzido usa snapshot de servidor estável e sincronização no cliente. Decisão em [ADR 0018](adr/0018-geometria-e-semantica-do-renderer.md).

Grupos têm uma única superfície nominal escalada. O culling dos retângulos de região testa também seus próprios bounds: o corpo em morph pode estar visível enquanto seu slot de destino está fora da viewport. Isso não autoriza podar descendentes apenas porque seu pai está fora da tela.

## Câmera e gestos

Por padrão, a escala máxima deriva de `max(6, 140 / menorLarguraNormalizada)`. Ganho do wheel, limites de escala, largura de leitura, duração de foco e threshold de pan são opções do hook React; resposta temporal é opção da matemática headless. O wheel normaliza `deltaMode`, usa ganho padrão de 0,0016 e conserva o ponto mundial sob o cursor. A aproximação ao alvo usa tempo entre frames em espaço logarítmico, com resposta padrão de 32 ms; um único rAF atende gestos longos. Ao restarem menos de 0,05 px relativos à viewport, aplica o alvo exato. O retângulo do stage é reaproveitado e invalidado por resize, scroll e novo pointerdown, evitando leituras síncronas por delta.

Um pointerdown primário esquerdo ou do meio cancela a animação pendente na câmera exibida, sem salto nem cooldown. O threshold de 5 px distingue clique de drag. Durante drag, deltas incrementais atualizam a câmera imediatamente. Se houver wheel ativo, o mesmo delta translada sua âncora e recalcula o alvo, evitando que o próximo frame sobrescreva o pan.

Pointer capture é readquirido após perda com botão ainda pressionado. O click pós-drag é suprimido; ativação por teclado continua disponível. Movimento sem botão não acompanha a câmera. O mapa impede drag nativo e seleção acidental de texto.

Clique seleciona sem mover a câmera. Foco explícito enquadra o ramo ou centraliza o próprio alvo quando a leitura requer escala maior. Reset usa `initialBounds`. Movimento reduzido aplica os destinos imediatamente. C/Cores alterna preenchimento, com guards para edição, modificadores e repetição.

## Verificação

Usar typecheck, lint, build e diff check. Para mudanças de geometria e gestos, usar harnesses temporários no navegador: colisões e bounds, identidade durante morph, reversão, âncora, pan com wheel, captura, ausência de click acidental, movimento reduzido e telas estreitas. Remover os harnesses ao concluir.

Na otimização anterior à extração reutilizável de 2026-11-05, o probe de 1.760 projeções da demo de 1.001 nós passou de 612,5 ms para 69,7–92,1 ms no Chrome local. O cálculo preservou a saída anterior em 5.728 comparações exatas; 5.340 casos adicionais validaram a translação da viewport, com diferença máxima de posição de 2,9e-12 px. A resposta matemática a um passo de zoom atingiu 90% em 83,3 ms, contra 133,3 ms antes, com amostragem de 60 Hz. Os gestos no navegador mantiveram erro de âncora inferior a 0,002 px e leitura de 140 px/full nas 746 folhas.

Esses ganhos não equivalem a uma garantia de 60 fps. No percurso de 220 frames, com até 327 nós visíveis, a build compilada teve mediana de 16,7 ms, p95 de 26,2 ms e máximo de 43,5 ms no Chrome headless local. O modo de desenvolvimento teve p95 de 42,9 ms. O cenário de pan isolado teve p95 de 16,8 ms; os trechos mais densos de zoom ainda concentram custo de layout e pintura.

Na extração genérica seguinte, o layout default de 1.001 nós permaneceu idêntico e o benchmark alternado Node de 1.760 projeções mediu 59,5 ms na engine genérica, contra 62,4 ms na implementação otimizada anterior. É uma diferença pequena e sujeita a carga/JIT, sem promessa de ganho de FPS. Foram validados 44 cenários de buckets, 121 fases reversíveis, tipagem do consumidor e opções alternativas. O Chrome confirmou mistura `#bc00bc` para vermelho/azul, conservação de 13 membros em quatro slots, mixer memoizado em pan, duas instâncias sem reset global, troca de dados/configuração, gestos ancorados e leitura das 746 folhas.

### Zoom dirigido ao Coral

Na rodada seguinte, o repro focou a região vermelha `node-0168`, no Chrome headless local a 1440×900: cursor no centro horizontal, 7 px abaixo do card inicial; 120 deltas de wheel −18, 120 de +18 e 50 frames de settle. O ganho e a resposta permaneceram 0,0016/32 ms. Foram medidos 289 intervalos. O percurso chegou a 231 corpos e 174 grupos em instantes diferentes; nenhum corpo esteve fora da viewport mais margem. O filtro de regiões eliminou as regiões fora de seus próprios bounds, sem alterar corpos/grupos em 13.826 comparações diferenciais.

| Execução | Antes | Depois |
| --- | ---: | ---: |
| Dev: p95 de frame | 50 ms | 33,4 ms |
| Dev: frames acima de 25 ms | 100 | 47 |
| Dev: tempo de script / tarefa | 3,21 / 5,85 s | 1,95 / 4,47 s |
| Build compilada: p95 de frame | 33,3 ms | 33,3 ms |
| Build compilada: frames acima de 25 ms | 38 | 17 |
| Build compilada: tempo de script / tarefa | 0,54 / 3,67 s | 0,47 / 2,98 s |

As builds anterior e nova usaram os mesmos fontes-base/dependências/compilador; a anterior foi reconstruída do commit `d6e4ec8`. Comparações não usam CPU profiler ativo nem throttle artificial. O alvo diagnóstico de p95 ≤25 ms **ainda falhou**, inclusive na build compilada: houve redução de trabalho e de frames lentos, sem eliminar todos os picos. Estilo, layout, pintura e montagem nas mudanças de LOD continuam relevantes. Forçar camadas adicionais com `will-change` piorou o teste e não foi adotado.

Geometria, ARIA e pixels foram idênticos em escalas fixas 0,3/1,6/4,2 frente ao checkpoint visual anterior. Os testes reais preservaram identidade/reversão, seleção, preenchimento, movimento reduzido, viewport mobile, duas instâncias com IDs iguais, callbacks/renderers novos durante atualização e leitura das 746 folhas. Não há harness permanente; os artefatos temporários são removidos após validação.
