# Arquitetura da primeira fatia

Para a visão geral navegável, use [platform-overview.md](platform-overview.md). Decisões duradouras e seus tradeoffs estão indexadas em [adr/README.md](adr/README.md); este documento mantém detalhes de implementação e evidências técnicas.

## Workspace e fronteiras

```text
packages/domain     Tipos e funções puras: árvore, progresso, ciclos e layout
apps/api            Fastify + zod + repositório + classificador Jev
apps/web            React + Vite; SpatialHome DOM, legado DOM/SVG, Lista, Kanban e formulários
apps/admin          React; leitura operacional da mesma API
```

O domínio não importa React, Fastify nem SDK externo. A API é a única detentora de `TYPESAFE_API_KEY`. Frontends consomem `/api` por proxy no desenvolvimento e nunca recebem segredos de Jev.

## Modelo de dados

### Ticket

`Ticket` possui `id`, `projectId`, `sequence`, `parentId: string | null`, título, descrição, status, `assigneeIds`, componentes e timestamps. Cada componente contém nome livre e seus próprios `assigneeIds`. Não há owner único. A profundidade não tem limite artificial e um ticket tem no máximo um pai hierárquico.

`status` é armazenado em todos os registros por simplicidade do snapshot, mas só é editável em folhas. Em pais, o valor armazenado não é apresentado como status manual: toda UI usa o agregado.

### TicketEdge

```ts
{
  id, projectId, sourceId, targetId,
  type: "hierarchy" | "dependency",
  style: { color, width, dashed },
  metadata: Record<string, string>,
  createdAt
}
```

Cada aresta tem identidade e estilo próprios. Alterar uma não altera nenhuma outra. Arestas de hierarquia são mantidas pela API em sincronia com `parentId`; não podem ser removidas isoladamente. Dependências podem ser criadas e removidas sem tocar a hierarquia.

### Integridade

- Criação/reparenting valida existência do pai no mesmo projeto, self-parent e se o novo pai é descendente do ticket.
- Dependências validam origem/destino no projeto, duplicidade, self-loop e caminho dirigido `target → … → source`.
- Excluir folha remove suas arestas incidentes. Excluir nó com filhos sem `recursive=true` retorna `409 HAS_CHILDREN`; com confirmação, remove descendentes e todas as arestas incidentes.
- zod valida bodies na borda HTTP; IDs de usuários e componentes são validados nas mutações.

## Progresso e apresentação

`getProgress` percorre todos os descendentes e considera apenas folhas (nós sem filhos). Para uma folha, ela própria é a unidade de cálculo. `getProjectProgress` usa o mesmo agregador puro sobre todas as folhas do projeto, incluindo florestas com múltiplas raízes; o cabeçalho não depende mais da primeira raiz.

```text
percent = round(doneLeaves / totalLeaves * 100)
cinza   = nenhuma folha iniciada
verde   = todas as folhas done
vermelho = qualquer início sem conclusão total
```

O rótulo `doneLeaves de totalLeaves folhas concluídas · percent%` acompanha a cor e usa `role="progressbar"` no canvas. A cor nunca é o único canal. Na apresentação de um agregado, folhas homogêneas preservam `todo`, `in_progress` ou `done`; qualquer combinação de status diferentes usa `mixed`/laranja `#a65400` (contraste 5,40:1 com branco). Vermelho `#b3263a`, verde `#16734a` e cinza `#625b70` têm contraste de 6,45:1, 5,86:1 e 6,46:1, respectivamente. Essa categoria visual não altera `AggregateStatus`, status manual nem as regras de domínio.

## Home espacial `/` e legado `/legacy`

`App.tsx` executa o bootstrap uma vez e compartilha projeto, tickets, usuários e `TreeIndex`. A rota usa History API, normaliza `/legacy/` e atualiza em `pushState`/`popstate`. `LegacyApp.tsx` mantém a experiência existente, incluindo protótipos DEV. `SpatialHome.tsx` recebe os mesmos dados sem herdar a máquina de estados da árvore; seleção, `TicketPanel` e `TicketForm` continuam sobre a mesma API. Dependências são iniciadas no legado.

### Canvas espacial Prezi

`components/spatial/spatialLayout.ts` calcula regiões retangulares determinísticas bottom-up. Cada geração tem largura/altura menores que o pai. Todo pai usa `ceil(sqrt(n))` colunas para organizar seus `n` filhos em linhas centralizadas; cada slot contém o envelope completo da subárvore filha, com o card alinhado ao topo da linha, e a região começa abaixo da borda inferior do pai. Gaps separam slots e linhas, e o flatten translada bounds pela posição do próprio nó. Um mapa por ID e bounds por subárvore são criados uma única vez por referência de tickets.

A normalização continua pela altura da subárvore. Para `auxílio = max(0, alturaDaSubárvore − 6)`, o fator é `min(1, (raioPróprio × (1 + 1,4 × auxílio) + 40 × auxílio) / raioBruto)`. Posições, larguras, alturas e envelopes recebem o mesmo fator. Como o pai não intersecta a região abaixo dele e slots/linhas são disjuntos, a separação vale recursivamente para todos os cards, inclusive fora da viewport. Contornos `spatial-region` tornam os slots visíveis sem criar arestas ou alvos de clique. A decisão atual está em [ADR 0013](adr/0013-regioes-retangulares-uniformes.md).

A câmera em `useSpatialCamera.ts` não reutiliza `useSemanticGestures` nem `semanticScene`. Zoom exponencial mantém exatamente o ponto mundial sob o cursor em todos os frames. A escala mínima é 0,02; o máximo é `max(6, 140 / menorLarguraNormalizada)` para layouts válidos, recalculado por snapshot. Pan usa threshold de 5 px, sem cooldown após zoom. Um novo pointerdown cancela a animação pendente a partir da câmera exibida, sem saltar até seu alvo. Durante o arraste, cada movimento soma seu delta imediatamente; se houver wheel ativo, o mesmo delta translada `anchor.cursorX/Y` e recalcula o alvo com `cameraAtAnchor`, preservando o ponto mundial agarrado e o ganho acumulado do zoom. Fit inicial/reset centraliza `initialBounds` e deriva a escala do footprint e da viewport, entre 0,45 e 1,2 no desktop e entre 0,2 e 1,2 em telas estreitas. **Explorar ramo** e breadcrumb comparam o fit da subárvore, limitado a 4 quando suficiente, com a escala necessária para deixar o alvo com 140 px; se a leitura dominar, centralizam o próprio alvo.

Wheel normaliza `deltaMode` e usa ganho 0,0016. Cada delta acumula o alvo anterior em um único rAF, inclusive se o ponteiro mudar de coordenadas. `spatialCameraMotion.ts` aproxima a escala exibida do alvo em espaço logarítmico com resposta exponencial de 55 ms. O cálculo usa o tempo desde o último frame, portanto a suavização continua depois dos primeiros 180 ms. Uma coordenada nova recaptura a âncora da câmera visível sem descartar deltas. O wheel só termina após 180 ms ociosos e erro projetado menor que 0,01 px; fit/foco usam um estado distinto com easing de 180 ms. Zoom-out restaura LOD/agregados, e movimento reduzido aplica o alvo imediatamente. A sonda confirmou que a falha anterior vinha de 119 reinícios/cancelamentos, não de eventos perdidos nem long tasks. Ver [ADR 0006](adr/0006-camera-e-gestos.md).

A cena pura em `spatialScene.ts` deriva full/compact/chip/dot, agregados por status e indicadores imediatos a partir do layout, da câmera e do `TreeIndex`. A primeira cena contém o root e seus filhos imediatos em duas linhas de três, seguidos por níveis revelados conforme o espaço. Apenas nós dentro da viewport e cujos ancestrais estão abertos entram no DOM. Dots conservam as dimensões calculadas. Clique abre detalhes sem mover a câmera.

O preenchimento por status começa ligado. A tecla `c`/`C` alterna `is-color-mode`, o botão **Cores** expõe `aria-pressed` e o wash usa `scaleY` com origem no topo. Cards preenchidos têm texto branco; dots e `mixed` preservam suas categorias visuais. Ctrl/Meta/Alt+C, repeat e edição em inputs, textareas, selects ou contenteditable não alternam o modo. Movimento reduzido remove a transição do wash.

Cada filho tem uma única representação geométrica: quadradinho de até 6 px sob o pai ou ticket no layout. Um progresso contínuo derivado da largura projetada do pai interpola posição e dimensões, com deslocamento vertical antecipado para separar linhas antes do movimento horizontal e do crescimento. A mesma chave/identidade DOM permanece na passagem individual, sem fade do corpo ou temporizadores de presença. Zoom reverso percorre a mesma geometria; culling considera o retângulo apresentado. Indicadores dos próprios filhos entram conforme o pai ganha espaço, e grupos `+N` tornam explícitos os filhos que não cabem. A composição da linha é estável, com até oito indicadores e um grupo; a linha reduz sua escala continuamente conforme a largura do pai, sem trocar a quantidade de slots por arredondamento. O grupo encolhe enquanto os representantes adicionais crescem a partir de tamanho zero. A visibilidade das prévias vai a zero antes do culling de ramos muito pequenos, sem corte opaco em 20 px.

Os limiares nominais são 100 px na raiz, 260 px na primeira geração e 180 px nas seguintes, com faixa de transição entre 85% e 115%. O limiar também é limitado por `110 × larguraDoPai / maiorLarguraDosFilhos` para completar a revelação antes do alcance de 140 px. O deslocamento vertical ocupa 45% do progresso de revelação, distribuindo o retorno aos indicadores por mais frames. As posições usam coordenadas do stage, no mesmo frame da câmera. Superfícies locais de pelo menos 6 px são escaladas até o tamanho apresentado para que bordas CSS não imponham um salto mínimo de 2 px a elementos subpixel. Movimento reduzido aplica imediatamente a nova câmera e a cena correspondente. Trocas de conteúdo de LOD mantêm o fade de 80 ms, com restauração ao reverter antes da troca. Ver [ADR 0014](adr/0014-continuidade-indicador-ticket.md).

Na revisão retangular com 1001 tickets, todos os 500.500 pares ficaram sem overlaps, sem filhos fora da região abaixo do pai e sem violações de bounds. No browser, burst e delta agregado produziram 1,2117237× com ganho 0,0016, 277 frames sem saltos e erro de âncora máximo de 0,00985 px. A folha real de depth 7 terminou full/140 px por wheel e Explore. Modo C, guards, reduced motion, painel, pan, mobile e legado passaram sem erros de console ou escritas HTTP.

A revisão de continuidade usou clock de frames controlado e uma árvore sintética de 1001 tickets. A interpolação continuou após 180 ms, o alvo acumulado sobreviveu a deslocamentos de 1 px do ponteiro, e grupos deixaram de saltar 4,5 px por mudança de capacidade. Na rolagem nativa em Chrome headless, 378 frames tiveram p95 de 16,7 ms, máximo de 16,8 ms, zero long tasks, erro de âncora máximo de 0,0015 px e retorno à escala inicial. Todos os 667 tickets folha do cenário continuaram full/140 px no alcance máximo; movimento reduzido, mobile e navegação para o legado passaram sem erros de console. Na regra anterior, que bloqueava pan durante wheel, o teste também reproduziu um pan residual de 101 px após um movimento novo de 1 px; atualizar a referência do ponteiro durante o bloqueio eliminou esse replay. Esses números descrevem o cenário de validação, não uma garantia de taxa de frames em qualquer máquina.

Na interação atual da home, arraste esquerdo ou do meio pode começar no primeiro movimento após o zoom. Wheel durante drag combina os dois gestos, com e sem Ctrl/Meta. Pointer capture é readquirido no próximo movimento se necessário; soltar o botão encerra apenas o drag. Um click real continua abrindo detalhes, o click pós-drag é suprimido, e drag nativo de imagens/texto não interfere na navegação. O harness CDP confirmou pan imediato de 40 × 30 px durante wheel, preservação do ganho `exp(70 × 0,0016)` e erro máximo de âncora de 0,0022 px. A alteração é exclusiva da home; o legado conserva sua prioridade de wheel.

### Cena semântica e gestos do legado

A home legada usa a árvore semântica de `TreeCanvas.tsx`, implementada em DOM/SVG e integrada aos mesmos painéis, formulários e dados da aplicação. A biblioteca React Flow permanece no workspace, mas o canvas de produção não depende mais dela. O protótipo A DEV e a home compartilham duas unidades de apresentação, sem alterar o domínio:

- `semanticScene.ts`: contexto visível, compactação bottom-up, agregados e cores, layout por dimensões reais, interpolação e âncora do cursor.
- `useSemanticGestures.ts`: foco explícito, atenção progressiva, câmera, wheel, pan e controles de enquadramento.

`tidyTreeLayout` fornece tickets, profundidade e contagens. A cena recalcula X com as larguras efetivas e gaps adaptativos de 18–30 px, separa subárvores e centraliza pais sobre filhos visíveis. Y usa a maior altura real de cada nível mais 28–36 px. O foco e seus descendentes, ancestrais, irmãos e resumos laterais formam a cena; nenhum irmão é escondido para caber.

### Índice derivado e custo de render

`buildTreeIndex`, em `packages/domain/src/treeIndex.ts`, deriva uma estrutura somente leitura por referência do array de tickets: `ticketById`, filhos já ordenados por pai, profundidade, altura, contagem da subárvore/descendentes, folhas por status, `Progress` por ticket e progresso do projeto. Uma fila bottom-up calcula os agregados em O(N), além da ordenação dos irmãos, com memória O(N) e sem recursão infinita em dados inválidos. As funções antigas continuam disponíveis para a API e para validações de compatibilidade; as regras e o formato de `Progress` não mudam.

O `App` constrói o índice em `useMemo` e compartilha a mesma instância com layout, cena, gestos, cards, Lista, Kanban e cabeçalho. `tidyTreeLayout` aceita esse índice opcionalmente. A cena mantém lookups de nó/ordem por layout em `WeakMap`, e o layout semântico mede e posiciona em duas passagens lineares com arrays numéricos, sem objetos/recursão por nó. O blend faz merge O(k) das cenas já ordenadas pelo layout original, sem reordenar a união.

Cada animação guarda `toScene` no início e reutiliza esse destino nos frames e na câmera final. Enquanto há `sceneOverride`, mudanças de zoom não recriam a cena gerada. O bootstrap inicial é deduplicado sob StrictMode e entra como transição React para não bloquear o primeiro gesto com uma segunda aquisição/render completa.

Cards e arestas usam blocos memorizados para conteúdo e identidade. Geometria, paths, classes e opacidade mantêm seu último estado em `WeakMap` e só escrevem no DOM quando o valor muda. Enquanto IDs e refs permanecem iguais, um fast path aplica essa geometria e a câmera diretamente no rAF, sem recriar fibers; qualquer mudança de IDs ou mounts usa o fluxo React completo. A superfície interna dos cards usa `content-visibility` para o trabalho fora da viewport; indicadores e handles ficam fora dessa superfície e continuam interativos. O minimapa consolida seus elementos não interativos em dois paths, preservando arestas e retângulos arredondados. Não há virtualização de tickets, workers nem WebGL; toda a cena lógica continua em DOM/SVG, e Lista/Kanban continuam renderizando todos os tickets.

### Compactação bottom-up e agregação

Cada nó tem `subtreeHeight`: folha vale 0; um pai vale 1 mais a maior altura dos filhos. A fase global é `(1,40 − zoom) / 0,12`, e a fase local subtrai essa altura, com tolerância de `1e-9` para estabilidade de ponto flutuante. As fases produzem `full → compact → chip → dot → agregado`, com dimensões contínuas dentro de cada faixa. Assim todas as folhas se reduzem antes dos pais, independentemente da profundidade absoluta ou do balanceamento do ramo.

Na fase de agregação, o descendente deixa de ser um nó independente e seu pai conserva identidade, tooltip, nome acessível, folhas concluídas/total e contagem de descendentes. `representedCount` reconcilia os tickets representados pela cena: a soma permanece igual ao total do projeto. Todo pai também mantém uma linha de indicadores dos filhos imediatos, mesmo quando já é dot/agregado. Essas prévias não entram novamente na soma nem criam arestas duplicadas; usam status, tooltip e acesso por teclado. Acima de oito filhos, seis individuais e grupos explícitos por status limitam a largura. Um indicador comum mede 10 px; o filho de um dot usa microdot de 6 px, sempre dentro de um alvo interativo de 20 px. O layout reserva a largura/altura da linha para evitar colisões.

O estado semântico inicial é 1,28. O máximo é 1,40; o mínimo global é `min(0,50, 1,40 − (alturaMáxima + 4) × 0,12)`, de modo que a compactação de fundo possa cobrir a altura real e terminar somente na raiz quando houver uma. Com **Foco no clique** ligado, o clique usa o LOD estável **1,04** (`1,40 − 3 × 0,12`). Cards textuais viram chips com identificador e início do título em uma linha com reticências; folhas na fase correspondente viram dots e o contexto continua bottom-up.

Wheel negativo sobre card ou indicador cria um `SemanticCompaction` independente da seleção. Para cada ramo, a fase é `(1,40 − zoom)/0,12 − subtreeHeight + progressoLocal`: folhas se reduzem primeiro, pais agregam na sequência e o alvo nunca desaparece, mesmo se for o foco atual. O terminal é `subtreeHeight + 4`, com o alvo como dot/agregado e indicadores imediatos. Ramos fora do alvo continuam na fase global. Wheel+ subtrai `progressoLocal` até zero antes de retomar a navegação anterior. Se o alvo for ancestral do foco ou resumo lateral, a travessia inclui sua subárvore sem duplicar IDs nem perder os agregados externos.

Tanto compactação local quanto global podem reduzir `camera.scale` em wheel negativo, a 0,00025 por pixel de delta, respeitando limites e a escala inicial. A reversão local guarda `fromScale` e termina exatamente nesse valor. O envelope da cena é calculado durante `layoutScene` e cacheado por referência em `WeakMap`. Em fundo livre, a âncora guarda `relativeX/Y = (ponto − min)/(max − min)` e remapeia essas frações para o envelope de cada frame; `camera.x/y` usa a escala interpolada no mesmo rAF. Não há fit, center ou salto final.

### Wheel e foco

- O mouse é sempre a origem `(0,0)` da expansão/contração. Sobre card, preserva-se a posição relativa; sobre microindicador, preserva-se esse indicador. Num ponto vazio a até 48 px CSS de um card, a âncora registra o ponto mais próximo da borda, sua fração na borda e o offset de cena: expansão e relayout preservam essa distância em todos os frames, sem deixar o card atravessar o cursor. Somente fundo realmente livre usa a coordenada normalizada no envelope, remapeada para cada nova cena em vez de congelar o pixel lógico antigo. A regra é idêntica com ou sem ticket selecionado: seleção muda detalhe do ramo, nunca puxa a câmera para o selecionado ou para o centro. `kind: card | indicator | scene` continua distinguindo a representação escolhida; `local` guarda a referência de borda.
- Numa sessão curta, se as coordenadas são as mesmas do wheel anterior, a `WheelAnchor` inteira é reutilizada — `kind`, `ticketId`, `sourceNodePresent`, `relativeX/Y`, `local`, cena, envelope e fallbacks — mesmo se a animação colocar outro alvo sob o mouse parado. As decisões de foco e compactação usam `anchor.ticketId` e o destino capturado na animação, não o hit DOM ao vivo, portanto um terceiro card ou `target=null` acidental não congela nem redireciona a transição preservada. Coordenadas novas capturam o alvo explícito ou a referência local/cena nova; retarget de A→B para C parte da `currentScene()` exibida, sem reset nem participação da seleção do painel. Depois do evento não há follow nem drag+wheel, com ou sem `Ctrl`/`Meta`; a sessão existe apenas para priorizar zoom e bloquear pan. `Ctrl`/`Meta` altera somente escala geométrica. `fitContext`, foco e Shift+wheel fazem settle sem restaurar cena intermediária.
- Se o card agrega, a âncora transfere continuamente para o indicador correspondente. `WheelAnchor.sourceNodePresent` registra se o nó real existia na captura: ao reaparecer depois de ausente, o card real assume a âncora com blend da prévia; se card e prévia coexistiam e a prévia foi escolhida deliberadamente, ela permanece como origem. Na âncora local, card e indicador presentes formam uma média ponderada pela opacidade do card; quando ambos desaparecem, o primeiro agregado visível no caminho ancestral registrado assume peso 1. Não se mistura o ancestral antecipadamente nem se cai em `sceneX/Y` durante a travessia. O cálculo inclui o border-bottom da containing block para alinhar subpixels do DOM.
- `Ctrl`/`Meta` + wheel altera somente escala com a mesma âncora. `Shift` + wheel faz pan horizontal. Os botões `+`/`−` usam a última posição conhecida do mouse dentro do canvas; o centro é apenas fallback acessível quando nunca houve ponteiro. `deltaMode` normaliza pixels, linhas de 16 px e páginas. `fitContext` é ação explícita separada e pode enquadrar.
- Mirar um card indica atenção sem mutar foco. Zoom+ sobre outro card progride entre as cenas do foco atual e do candidato, mesmo se outro ticket estiver selecionado; zoom-out nunca troca foco para estabilizar a câmera. Reverter antes da conclusão retoma o foco anterior. Wheel no fundo não escolhe ticket arbitrário.
- **Foco no clique** começa desligado. Nesse modo, clique/Enter em card ou indicador apenas seleciona/abre detalhes, sem mudar foco, LOD, cena ou câmera. Ligado, o próximo clique usa o LOD 1,04 e a transição ancorada. Alternar o toggle não faz reset nem recentro; breadcrumb continua sendo foco explícito. Pan, LOD e enquadramento não apagam seleção nem alteram `parentId`.

Cards e arestas são calculados a partir dos mesmos retângulos no mesmo frame. Não há transições CSS independentes de `transform`, `d` ou cor semântica. Durante a transferência, larguras, alturas, opacidades e cores são interpoladas e a união das duas cenas passa por um novo layout completo: coordenadas nunca são interpoladas isoladamente, pois isso permitiria colisões. Nós que entram expandem a partir de dot e nós que saem comprimem até o agregado, permanecendo representados e sem usar opacidade para esconder colisões. Conexões cujos extremos não estão representados não são desenhadas; estilos persistidos das arestas não mudam.

### Animação coordenada de zoom e foco

Wheel semântico, `Ctrl`/`Meta` + wheel e os controles `+`/`−` usam **180 ms** com `easeOutCubic`. Um primeiro tick cancelável por `setTimeout(0)` e os demais `requestAnimationFrame` atualizam progresso, câmera, dimensões, posições, opacidades, cores e arestas em conjunto. Os refs são atualizados sincronamente para retargets, sem `flushSync`; a âncora é recalculada pelos retângulos relayoutados em cada frame, inclusive durante a transferência filho→agregado.

Cada scroll captura a cena visual corrente em `fromScene`, inclusive retângulos e opacidades de uma animação em andamento. `toScene`, `toTransition` e `toCompaction` mantêm o destino lógico separadamente e acumulam os deltas, de modo que bursts e reversões não percam intenção nem reiniciem da cena abstrata anterior. Um novo evento cancela o timeout/rAF anterior e retoma da geometria exibida, sem fila nem callbacks obsoletos. O estado final equivale à sequência de deltas aplicada diretamente.

Clique focalizado e wheel compartilham `startAnchoredAnimation`: cada frame calcula a câmera com `cameraForAnchor`, inclusive no estado final e em `prefers-reduced-motion`. Clique/breadcrumb usa **220 ms** e easing simétrico; wheel/controles usam 180 ms. O painel abre imediatamente, mas o `ResizeObserver` não recentraliza nem desloca a câmera para o foco: durante uma animação, o próximo frame resolve a nova largura; em repouso, recalcula a câmera pela última âncora do ponteiro. Pan e `Shift` + wheel continuam manipulação direta, sem easing. Movimento reduzido aplica imediatamente o estado final preservando o mesmo ponto.

### Pan e dependências

Botão esquerdo funciona no fundo e sobre cards; o do meio continua disponível. O gesto começa após 5 px, preservando clique. O drag guarda `lastX/Y`, não uma baseline antiga de câmera. Durante qualquer sessão de wheel, o zoom tem prioridade e o delta do drag é descartado, com ou sem `Ctrl`/`Meta`. Sem sessão, cada pointermove soma somente seu delta à câmera atual, preservando o drag normal sem dupla contagem. Animação de foco, não de wheel, é cancelada ao iniciar pan.

Clique real no fundo (`stage`, `scene` ou SVG sem ticket) e `Escape` fora de inputs limpam `selectedTicketId` e `selectedEdgeId` e fecham o painel. A supressão de click após drag impede deseleção acidental; arestas e controles não são fundo. `settleAnimation` cancela rAF/timer, remove `sceneOverride`, conclui foco/câmera coerentes e bloqueia atenção até o próximo movimento real. `attentionId` também é limpo ao sair do stage ou quando o nó desaparece.

Pointer capture é adquirido no threshold e readquirido se `lostpointercapture` chegar com botão pressionado; esse evento não encerra o drag nem o zoom. `pointerup`, `pointercancel` ou `buttons=0` limpam o estado. A supressão do click pós-drag não usa timer: permanece até o click ser consumido, é limpa no próximo pointerdown intencional e permite ativação por teclado/programação com `detail=0`. Seleção/arraste nativo são prevenidos somente durante o gesto.

Cards e o SVG das arestas compartilham uma wrapper de cena transladada imediatamente pela câmera. Cada `TicketEdge` conserva ID, seleção, cor, espessura e tracejado. Dependências são criadas pelo conector do card ou pelo fluxo do painel, nunca por mudança hierárquica. O modo `C`, o minimapa, o enquadramento e `prefers-reduced-motion` permanecem disponíveis.

Na revisão do dataset com 36 tickets, clique/resize passou de 156,18 px de deriva para no máximo 0,58 px; agregação terminou em 0,071 px e os frames verificados tiveram zero overlaps e arestas com erro de até 0,016 px. Wheel off-center/bursts/trackpad ficou abaixo de 0,712 px e `Ctrl`+wheel abaixo de 0,284 px. Ao atingir 140% sobre o candidato, a transferência conclui na mesma animação, sem deixar atenção pendente no teto; reversão antes do teto restaura o foco anterior. Em 390 × 844, os dois toggles ocupam o toolbar sem sobreposição e `scrollWidth=390`.

Na revisão de liberdade de navegação, wheel seguido de movimento de 160 × 80 px tinha 178,885 px de erro e foi abaixo de 0,001 px na matriz própria; o harness independente mediu até 0,933 px por arredondamento de coordenadas. Drag com wheel recuperou os 100 px de pan perdidos, manteve o LOD e não abriu painel.

Na correção urgente de âncora e seleção, o ciclo de quatro reduções e quatro ampliações preservou a `WheelAnchor` integralmente em `samePoint`, inclusive quando o alvo entra sob o mouse parado. A matriz independente mediu topLeft=0,298 px, bottomRight=0,637 px, reducedMotion=0,652 px, stablePreview=0,016 px, browserEdge=0,613 px e mobile=0,488 px, sem `missing` nem exceções. `Ctrl` e `Meta` não fazem follow; drag com wheel não compõe pan em nenhum modificador. Fundo/Esc limparam seleção e painel; interrupções não deixaram opacidade parcial nem `is-attention`. Drag normal fora do wheel e o próximo clique continuaram funcionando.

Na revisão Prezi, o retarget A→B→C e o harness original passaram com e sem seleção. O ponto 6 px abaixo do card não foi atravessado em nenhum frame. A travessia card→indicador→agregado passou com erro máximo de 0,579 px e `missing=0`; a matriz de navegação passou para referências inferior, esquerda e direita e para reduced motion. A referência Variant A também passou, com erro máximo de 0,264 px.

Evidências: [âncora após o ciclo](assets/semantic-zoom/anchor-corners-after.png), [seleção limpa](assets/semantic-zoom/selection-clear-after.png), [interrupção estabilizada](assets/semantic-zoom/interruption-settled-after.png), [LOD de clique a 104%](assets/semantic-zoom/click-context-104.png), [modo C e título truncado](assets/semantic-zoom/click-context-color-104.png), [agregado misto com microdots](assets/semantic-zoom/mixed-microdots-92.png), [toolbar mobile na home](assets/semantic-zoom/mobile-toolbar-home.png), [na referência A](assets/semantic-zoom/mobile-toolbar-variant-a.png), [retarget Prezi sem alterar seleção](assets/semantic-zoom/prezi-retarget-after.png) e [âncora local após a expansão](assets/semantic-zoom/prezi-local-anchor-after.png).

## API REST principal

- `GET /api/health`, `/api/bootstrap`, `/api/projects`, `/api/users`, `/api/projects/:id`.
- `POST /api/projects/:id/tickets`, `PATCH /api/tickets/:id`, `DELETE /api/tickets/:id?recursive=true|false`.
- `POST /api/projects/:id/tickets/suggest` — somente sugere; nunca cria ticket.
- `POST /api/projects/:id/edges` — cria dependência.
- `PATCH /api/edges/:id` — atualiza o estilo individual.
- `DELETE /api/edges/:id` — somente dependências; hierarquia é protegida.

Erros de regra retornam JSON `{ error, message }` com status 4xx. CORS é restrito às portas locais dos dois frontends. Como não há autenticação/autorização nesta fatia, a API escuta por padrão apenas em `127.0.0.1`; definir `HOST` explicitamente permite outro bind por conta do operador.

## Persistência local

`TreeRepository` define `snapshot()` e `mutate()`. `JsonTreeRepository` carrega o seed na ausência do arquivo, clona o estado para cada mutação, serializa operações em uma fila, grava JSON em arquivo temporário no mesmo diretório e usa `rename` atômico antes de publicar o novo estado em memória.

Isso evita snapshots parcialmente escritos e escritas concorrentes dentro de **um processo**. Não há locking multi-processo, isolamento relacional, migrações, replicação ou recuperação transacional. **Produção exige implementação do repositório sobre banco transacional.** Dados gerados ficam fora do Git; `TREEPM_DATA_FILE` permite configurar o caminho.

## Jev / TypeSafe AI

Somente `apps/api` depende de `@typesafe-ai/sdk` **0.7.0**. Com credencial, o classificador cria `new TypeSafeClient({ defaultModel: "jev-latest" })` e usa `client.systemOne` com `choice`.

1. Uma `Choice` classifica a disciplina entre backend, frontend, design, produto e outro.
2. A partir das raízes, cada `Choice` escolhe um ramo entre no máximo 20 candidatos do nível.
3. Abaixo da raiz, `__stop__` permite permanecer no pai atual.
4. O percurso se limita a seis níveis por chamada de sugestão, sem impor limite à hierarquia criada manualmente.
5. Estado enviado contém apenas título/descrição truncados e caminho de títulos; critérios contêm título e descrição curta dos candidatos, nunca milhares de tickets completos.

Antes de chamar o modelo, `classificationLimitations` examina raízes, quantidade de filhos e profundidade. Mais de 20 candidatos em qualquer nível ou ramos além dos seis níveis analisáveis impedem uma sugestão parcial: a resposta tem `mode="unavailable"`, `manualRequired=true`, `parentId=null` e uma mensagem que identifica a limitação. Nenhum ramo é cortado silenciosamente.

Cada nível conserva `choice`, `probabilities` e `confidence`. A confiança final é o mínimo do percurso e da categoria. Abaixo de `0.65`, `manualRequired=true` e a UI não oferece aplicação automática dos campos sugeridos. Mesmo com confiança alta, a pessoa precisa confirmar o preenchimento e depois criar o ticket.

Sem chave ou diante dos limites acima, a resposta é `mode="unavailable"`; falha externa é `mode="error"`. Todos exigem seleção manual e não afirmam sucesso do modelo. Contratos de referência: [quickstart oficial](https://docs.typesafe.ai/introduction/quickstart.md) e [SDK JavaScript oficial](https://docs.typesafe.ai/sdk/javascript.md).

## Verificação e limites

Na carga local de 1000 tickets com uma única raiz, o harness CDP original mediu baseline de p95 de 816,6 ms para 1 scroll e 1333,4 ms para 8, com tarefas máximas de 770 ms e 1001 ms. Após índice, caches e redução de renders, a medição final foi p95 de 50 ms para 1 scroll e 16,8 ms para 8, com zero long tasks e zero erros de runtime nos dois cenários. Esses números são locais e não implicam virtualização nem garantia para árvores arbitrariamente maiores.

Na revisão da compactação local, um ticket criado pelo usuário elevou o dataset para 1001 registros e aumentou sua altura. Após caches CSSOM, layout iterativo e fast path de frames, a medição final foi p95 de 16,8 ms para 8 scrolls e tarefa máxima de 62 ms, portanto PASS nesse cenário. O cenário de 1 scroll continua acima do budget: p95 de 66,6 ms e tarefa máxima de 53 ms, sem erros de runtime. Esse resultado permanece uma limitação aberta, não um PASS.

A fatia não contém suíte de testes por decisão explícita. `pnpm typecheck`, `pnpm lint`, `pnpm build` e chamadas reais à API são os portões mínimos. Web/admin são validados por compilação e consumo de endpoints; harnesses temporários de CDP verificam home, gestos e performance sem constituir uma suíte committed. Não há validação online de Jev sem uma credencial real.
