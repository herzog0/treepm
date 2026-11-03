# Proposta de zoom semântico e foco espacial

Status: **direção A incorporada à home**; C e D continuam referências para views futuras. As medições históricas abaixo documentam a avaliação dos protótipos.

## Implementação atual na home

A implementação de produção foi reescrita em `TreeCanvas.tsx`, `semanticScene.ts` e `useSemanticGestures.ts`, integrada aos painéis e dados reais, sem expor o switcher descartável na rota `/`.

- Wheel semântico e `Ctrl`/`Meta` + wheel geométrico preservam o ponto sob o cursor, inclusive durante LOD.
- O foco é explícito; zoom+ sobre outro card interpola as duas cenas de forma progressiva e reversível. Pan e wheel no fundo não inferem um novo foco.
- O arraste esquerdo funciona no fundo e sobre cards após threshold de 5 px, com pointer capture e limpeza em todos os encerramentos.
- Posições, dimensões, opacidades e arestas usam o mesmo progresso temporal. Wheel semântico, `Ctrl`/`Meta` + wheel, controles, clique e breadcrumb animam a cena por 220 ms de `requestAnimationFrame`, sem trilhos CSS independentes de `transform`/`d`. FLIP com Web Animations API permanece uma evolução possível, não uma descrição do código atual.
- Seleção de tickets/arestas, edição de estilo, dependências, minimapa, C e reduced motion continuam integrados. Novas ações capturam a cena visual corrente e interrompem o loop anterior sem fila. Scrolls acumulam o destino lógico separadamente, enquanto cada frame recalcula a câmera para conservar a âncora sob o cursor.

Em Chrome isolado a 1440 × 1000, a reprodução anterior apresentava deriva de 82,48 px no wheel e 243,31 px de erro no arraste iniciado sobre card. Depois da correção, os dois percursos ficaram em 0,00 px. Na transferência progressiva, a âncora teve erro máximo de 0,036 px e as arestas 0,014 px; a reversão parcial restaurou foco e larguras. Esses números cobrem o seed e os gestos exercitados, não árvores de grande escala.

Uma revisão posterior de `ticket-023 → ticket-027` encontrou até cinco pares sobrepostos nos estados intermediários, embora origem e destino fossem válidos. A correção interpola somente as dimensões e relayouta a união das cenas em cada frame; entradas/saídas expandem ou comprimem até dot sem ocultar irmãos. O harness passou a verificar todos os retângulos a cada wheel: cinco passos de ida e quatro de ida/volta ficaram com zero overlaps, erro máximo de âncora de 0,005 px e erro máximo de arestas de 0,014 px. O harness usa a razão inicial efetivamente recebida pelo `WheelEvent`, evitando acumular a diferença entre coordenadas CDP fracionadas e as coordenadas inteiras expostas pelo Chrome.

Na animação por clique, duas execuções completas na home produziram 9–10 estados intermediários e terminaram em 219–229 ms. O painel permaneceu selecionado e o card final ficou fora da área coberta. Redirecionamentos tiveram 0,000 px de salto no microtask do evento; clique e interrupções tiveram zero overlaps e arestas com erro máximo de 0,016 px. O wheel interrompeu o loop e manteve a largura intermediária estável. Movimento reduzido concluiu sem estados espaciais intermediários. A referência A produziu 11 estados intermediários em 236 ms, também sem overlaps.

Na revisão temporal do wheel, o baseline tinha zero larguras intermediárias e saltos de até 156,861 px. Depois da correção, o wheel único produziu 7 larguras intermediárias distintas em 235,2 ms; a sequência `-120/-120/+120` produziu 35 frames intermediários, conservou 24% de atenção e terminou em 234,8 ms após o último delta. O burst de cinco deltas concluiu a troca para `ticket-027`; todos os percursos tiveram salto de evento de 0,000 px e zero overlaps. A âncora máxima foi 0,263 px no burst e as arestas ficaram em até 0,016 px. Ctrl+wheel, fundo, controles, clique, pan, referência A e reduced motion também passaram; não houve long tasks no intervalo medido. São medições do seed em Chrome isolado, não uma garantia para árvores de grande escala.

## Decisão recomendada

Adotar **foco espacial explícito**: a pessoa escolhe o ticket que organiza a cena; o nível semântico controla quanta informação cada contexto apresenta; a câmera controla apenas a escala geométrica. O gesto principal coordena semântica e câmera, enquanto um modificador permite controlar somente a câmera.

A implementação deve combinar:

- A estrutura espacial, as arestas, a densidade medida e o modo de cores da variante A.
- O foco previsível, os grupos de irmãos e a compressão da variante B.
- Uma view própria de faixas por subárvore, baseada em C, com controle geométrico independente.
- Uma Lista hierárquica própria, baseada em D, com guias, colapsos e densidade confortável.

Não promover nenhum protótipo diretamente. Eles são código descartável para responder à pergunta de UX.

## Direção aprovada na revisão

A pessoa usuária escolheu a **A como direção da árvore**. C e D não serão descartadas como conceito: C deve evoluir para uma view de **faixas por subárvore** e D para a **Lista hierárquica**, ambas selecionáveis separadamente na integração definitiva. Isso ainda não as transforma em tabs de produção.

O refinamento da A tem três objetivos: reduzir gaps sem sacrificar separação entre subárvores, recalcular posições a partir das dimensões reais e encurtar o movimento. A revisão também aprovou um **modo de cores com `C`**: o indicador superior se expande de cima para baixo até preencher o card, enquanto o texto muda para branco de forma sincronizada. No protótipo A, o modo é alternável por teclado e por um botão acessível. Cores continuam acompanhadas de texto e progresso, e o modo respeita `prefers-reduced-motion`.

Medição anterior ao refinamento, em 1440 × 1000: 400 ms para posição/dimensões, 180 ms de espera do foco, 19 pares de cards sobrepostos e gaps de 59 px entre vários irmãos. O contraste dos status com texto branco era 3,55:1 no vermelho e 4,04:1 no verde; o objetivo do preenchimento é pelo menos 4,5:1. Esses números diagnosticam o protótipo, não uma meta de desempenho da implementação final.

Depois do refinamento, a cena inicial com 34 tickets não tem sobreposição; o grupo de irmãos medido usa gaps de 18–26 px e as transições duram 200 ms. O preenchimento dura 230 ms, com o texto mudando para branco durante a descida. O contraste com branco ficou em 6,04:1 no vermelho, 6,28:1 no verde e 5,95:1 no cinza. `C` ativa e desativa o modo, ignora campos editáveis e `Ctrl+C`; movimento reduzido elimina animação e atraso do texto. O foco profundo comprimido e a viewport de 390 × 844 também não apresentaram sobreposição ou overflow global nesses percursos.

No wheel com os 34 tickets, foram observados 21 frames com média de 16,67 ms, percentil 95 de 16,8 ms, nenhum intervalo acima de 34 ms e nenhuma tarefa longa acima de 50 ms. Isso é evidência somente do cenário exercitado neste Chrome, não da matriz de escala nem da futura implementação de produção.

### Sincronização do pan e limite conhecido

Uma reversão rápida de pan afastava as arestas dos cards em até 172,84 px antes de reconectá-las no repouso. A correção separa `camera.x/y` das coordenadas base: cards e SVG ficam dentro de `.proto-a-scene`, transladada imediatamente pelo mesmo `translate3d`. O pan não reinicia mais transições independentes de `transform` e `d`; o cálculo de foco compensa a translação da câmera. Nas medições seguintes, as 33 conexões da cena completa ficaram com erro de 0 px durante o pan com foco fixado; com foco inferido e resumos, o erro máximo observado foi 0,015 px. [Screenshot do pan sincronizado](assets/semantic-zoom/proto-A-pan-sync.png).

A verificação ampliada encontrou, **no protótipo anterior**, um problema separado no zoom semântico: transições independentes de cards e paths divergiam temporariamente durante mudanças de LOD. Foram observados 14,11 px com foco fixado e até 35,22 px com foco automático, com posterior reconexão. A implementação atual substituiu essas trilhas independentes por cena e arestas calculadas no mesmo render; a seção do topo registra as medições posteriores. O FLIP com Web Animations API permanece disponível como evolução, não como correção já aplicada.

## Evidências reunidas

Foram comparadas a UI atual e quatro protótipos em 1440 × 1000, com foco profundo, compressão máxima e colapso da lista.

| Experimento | O que funciona | O que não deve ser preservado |
| --- | --- | --- |
| Árvore atual | Canvas, pan, zoom e cards familiares | LOD global por profundidade, sem foco ou compressão por contexto |
| A — Viewport adaptativa | Árvore espacial, arestas, foco e quatro resumos laterais | Foco inferido por padrão; a 50% houve sobreposição dos filhos com o pai e resumos cortados |
| B — Foco explícito | Breadcrumb, irmãos claros, cards → chips → quadradinhos e 51 animações ativas de 300–420 ms | Linhas fixas deixam grande vazio após compressão; faltam arestas e relayout vertical |
| C — Dois controles | Separação explícita entre informação e câmera; boa visão de faixas | Carga conceitual excessiva para o gesto principal; hierarquia espacial menos evidente |
| D — Lista | Recuo, guias, pais/folhas, sticky header e colapso de 33 descendentes | Ajustes finais de densidade e navegação por teclado ainda são necessários |

Evidências visuais:

- [Árvore atual](assets/semantic-zoom/design-before-tree.png)
- [A com foco profundo](assets/semantic-zoom/proto-A-focus.png)
- [A com sobreposição a 50%](assets/semantic-zoom/proto-A-compressed.png)
- [A refinada, em modo neutro](assets/semantic-zoom/proto-A-refined.png)
- [A durante o preenchimento de cores](assets/semantic-zoom/proto-A-color-mid.png)
- [A com preenchimento de cores concluído](assets/semantic-zoom/proto-A-color-on.png)
- [B com foco explícito](assets/semantic-zoom/proto-B.png)
- [B com irmãos e filhos em status](assets/semantic-zoom/proto-B-status.png)
- [C com dois controles](assets/semantic-zoom/proto-C.png)
- [D expandida](assets/semantic-zoom/proto-D.png)
- [D com 33 descendentes ocultos](assets/semantic-zoom/proto-D-collapsed.png)

Os protótipos navegáveis permanecem temporariamente em `/?variant=A`, `/?variant=B`, `/?variant=C` e `/?variant=D`, somente em DEV.

## Como o Jev foi usado

O Jev foi usado **offline**, com perguntas atômicas de `Choice` e `Score`, para comparar alternativas e explicitar trade-offs. Ele não gerou a interface e não substituiu screenshots ou validação humana.

Na comparação de foco, a escolha foi `foco_explicito`, com probabilidade 0,92 e confiança 0,88. As notas são de 1 a 5:

| Variante | Legibilidade | Continuidade | Contexto | Escala | Previsibilidade | Viabilidade |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| Viewport adaptativa | 3,91 | 4,33 | 4,48 | 4,37 | 3,93 | 3,23 |
| Foco explícito | 4,52 | 4,66 | 4,84 | 4,63 | 4,88 | 3,56 |
| Dois controles | 3,87 | 3,94 | 4,09 | 4,30 | 3,94 | 3,26 |

Na comparação de movimento, `flip_compartilhado` recebeu probabilidade 1 e confiança 1:

| Estratégia | Orientação | Fluidez | Desempenho | Robustez |
| --- | ---: | ---: | ---: | ---: |
| FLIP compartilhado | 4,87 | 4,84 | 4,27 | 3,87 |
| Fade sequencial | 1,44 | 2,46 | 2,34 | 1,97 |
| Câmera com corte no threshold | 2,42 | 2,38 | 2,40 | 2,07 |

Depois das observações visuais, uma nova `Choice` comparou o híbrido proposto, as linhas fixas de B e a câmera automática de A. O híbrido espacial explícito recebeu probabilidade 1 e confiança 1.

Também foi exercitada a classificação real de um ticket sobre cache e paginação. A categoria `backend` teve probabilidade 0,96, mas o posicionamento ficou ambíguo e a confiança mínima foi 0,20. A API corretamente retornou `manualRequired=true`, confirmando que confiança por etapa deve continuar visível e que nenhuma decisão de produto deve ser automática por padrão.

**O Jev não participará do loop de pan, foco, layout ou animação.** Essas regras precisam ser determinísticas, testáveis e instantâneas. Avaliações com Jev podem ser repetidas offline quando novas alternativas de UX forem comparadas.

## Modelo de interação

### Dois níveis, sem confundir seus papéis

`semanticLevel` é um estado contínuo de 0 a 3:

| Faixa | Representação de um grupo de irmãos |
| --- | --- |
| 0–0,75 | Cards completos |
| 0,75–1,5 | Cards compactos |
| 1,5–2,25 | Chips com identificador e título curto |
| 2,25–3 | Quadradinhos de status, com tooltip e nome acessível |

A escala é contínua para o motor de layout; as apresentações possuem pequenas zonas de histerese para não oscilar entre dois estados no mesmo threshold.

`camera.zoom` é independente e nunca determina sozinho o conteúdo. Ampliar a câmera com o modificador pode deixar um quadradinho maior sem transformá-lo novamente em card.

### Gestos

| Entrada | Resultado |
| --- | --- |
| Wheel principal | Altera o nível semântico; a câmera acompanha suavemente dentro de limites legíveis |
| `Ctrl`/`Meta` + wheel ou pinch | Altera somente a câmera, sem mudar a semântica |
| `Shift` + wheel | Pan horizontal |
| Arraste do fundo ou sobre card | Pan após threshold, sem alterar foco ou semântica |
| Clique/Enter em ticket | Define foco explícito |
| `0` | Enquadra o contexto atual |
| `1` | Retorna ao projeto, preservando o foco anterior para poder voltar |
| `Esc` | Move o foco para o pai |
| Setas | Navega entre pai, filhos e irmãos |
| Slider semântico opcional | Alternativa acessível e precisa ao wheel, sem conceito adicional obrigatório |

O foco **não muda porque a viewport se moveu**. A inferência de viewport pode virar uma preferência opcional no futuro, nunca o comportamento inicial.

## Regras da cena em foco

Dado um `focusId`:

1. O foco permanece legível e visualmente destacado.
2. Seus ancestrais aparecem no caminho e no breadcrumb.
3. Todos os irmãos diretos continuam representados em alguma forma, mesmo que como quadradinhos.
4. Todos os filhos diretos continuam representados até o nível máximo de compressão.
5. Descendentes mais distantes são resumidos progressivamente sob o pai visível mais próximo.
6. Ramificações irmãs de um ancestral aparecem como o pai resumido daquela subárvore, com título, progresso e quantidade de descendentes.
7. Outras raízes ficam resumidas da mesma forma.
8. Um resumo nunca é um nó sintético sem identidade: é outra apresentação do mesmo ticket, permitindo animação e navegação até ele.
9. Seleção, estilo das arestas e dados do domínio não mudam quando a apresentação muda.

Um ticket resumido apresenta o agregado de toda a sua subárvore. A soma dos nós visíveis e dos descendentes representados nos resumos deve sempre reconciliar com o total do projeto.

## Layout dinâmico obrigatório

Não é suficiente reduzir cards ou filtrar profundidades. Cada mudança de foco ou nível semântico produz uma nova cena completa:

1. Calcular o contexto visível e o que cada nó representa.
2. Escolher a representação inicial de cada grupo de irmãos a partir de `semanticLevel`.
3. Medir largura e altura reais das representações.
4. Se um grupo exceder a largura segura da viewport, comprimir **somente aquele grupo** um nível adicional.
5. Se ainda exceder com quadradinhos, preservar todos e permitir pan; nunca esconder irmãos para resolver overflow.
6. Calcular posições top-down com as dimensões medidas, gaps por nível e centralização dos pais.
7. Recalcular alturas e gaps verticais para impedir sobreposição.
8. Recalcular arestas a partir dos mesmos retângulos usados pelos cards.
9. Calcular o retângulo total do foco e o retângulo dos resumos laterais.
10. Ajustar somente o deslocamento necessário da câmera para manter o contexto atual compreensível.

O enquadramento não deve reenquadrar o projeto inteiro a cada delta. Durante o gesto, a câmera acompanha o centro do foco; após aproximadamente 180 ms de estabilidade, corrige apenas o necessário para manter foco, irmãos e resumos dentro de uma margem segura. O comando explícito `0` pode enquadrar todo o contexto.

### Invariantes

- Nenhuma sobreposição entre cards em nenhum nível.
- Nenhuma aresta com extremo inexistente.
- Nenhum texto essencial reduzido pela escala semântica até ficar ilegível.
- Nenhum irmão removido sem estar representado por card, chip, quadradinho ou resumo explícito.
- Nenhuma mudança automática de foco durante pan ou enquadramento.
- Um resumo sempre informa quantos descendentes representa e o progresso agregado.

## Animação e continuidade

Usar FLIP — First, Last, Invert, Play — com identidade estável por ticket.

1. Antes da mudança, registrar os retângulos atuais dos nós visíveis.
2. Calcular a nova cena, mantendo nós de entrada e saída durante a transição.
3. O wrapper do React Flow recebe a posição final; um wrapper interno faz a translação inversa para que o ticket comece visualmente onde estava.
4. Animar o wrapper interno até zero e as dimensões até os novos valores.
5. Cards completos, chips, quadradinhos e resumos fazem crossfade dentro do mesmo ticket.
6. Nós que saem convergem para o pai que passa a representá-los; nós que entram emergem desse resumo.
7. Arestas são interpoladas com o mesmo progresso temporal dos retângulos, sem transição independente.
8. Ao terminar, remover os nós de saída e aplicar virtualização fora da viewport.

Duração recomendada após a revisão: **180–260 ms**, com easing `cubic-bezier(0.22, 1, 0.36, 1)`, sem bounce. O preenchimento do modo de cores usa aproximadamente 230 ms, com a mudança do texto coordenada ao avanço do fundo. Uma nova roda de zoom interrompe a animação atual e retoma do estado visual apresentado naquele instante; animações nunca ficam enfileiradas. A meta anterior de 280–420 ms foi descartada por parecer lenta na avaliação da pessoa usuária.

Não usar React `setState` a cada frame. A cena muda no React; a interpolação usa refs e Web Animations API. Somente transform e opacity são animados em larga escala. Dimensões são animadas apenas no conjunto visível e limitado. Sombras e efeitos caros ficam estáticos.

Com `prefers-reduced-motion`, aplicar o estado final imediatamente ou uma transição mínima de opacidade, sem deslocamento espacial.

## Arquitetura de implementação

Manter React Flow para viewport, pan, pinch, minimapa e controles. Introduzir um motor de cena separado do canvas, sem promover o código dos protótipos.

```text
packages/domain/src/semantic-scene.ts
  Índices da árvore, contexto, resumos e tipos da cena

apps/web/src/components/tree/SemanticTreeCanvas.tsx
  Integração com React Flow e ciclo de vida da cena

apps/web/src/components/tree/useSemanticZoom.ts
  Reducer de foco, semântica, câmera, pan e enquadramento

apps/web/src/components/tree/useFlipScene.ts
  FLIP, interrupções, entradas/saídas e reduced motion

apps/web/src/components/tree/SemanticNode.tsx
  Cards, chips, quadradinhos e resumos com wrappers de animação

apps/web/src/components/tree/SemanticEdge.tsx
  Arestas independentes e interpolação coordenada

apps/web/src/components/tree/TreeControls.tsx
  Breadcrumb, nível semântico, foco e controles de câmera
```

Estado conceitual:

```ts
interface SemanticViewportState {
  focusId: string;
  previousFocusId: string | null;
  semanticLevel: number; // 0..3
  camera: { x: number; y: number; zoom: number };
  scene: SemanticScene;
  transition: {
    active: boolean;
    startedAt: number;
    fromSceneId: string | null;
  } | null;
}
```

`SemanticScene` contém somente apresentação: nós, arestas, retângulos, contadores de resumos e relações de contexto. Não altera `Ticket`, `TicketEdge`, `parentId`, status ou estilos persistidos.

### Desempenho

- Criar índices `Map` de tickets, filhos, profundidade e agregados quando os dados mudarem.
- Calcular progresso em uma travessia pós-ordem, evitando repetir descendentes para cada card.
- Recalcular layout apenas quando foco, semântica ou dimensões da viewport mudarem.
- Manter no DOM apenas a cena relevante e os nós em transição.
- Não enviar toda a árvore ao Jev e não chamar IA durante interações.
- Introduzir worker para layout somente se as medições demonstrarem necessidade.

## Proposta para a Lista

Adotar a estrutura da variante D como base de produção:

- Recuo de aproximadamente 24–25 px por profundidade.
- Guias verticais discretas e marca horizontal para o item atual.
- Chevron com `aria-expanded`, `aria-label` e suporte a setas do teclado.
- Pais com peso e fundo sutis; folhas com densidade confortável.
- Cabeçalho sticky dentro da área de scroll.
- Chave do ticket com estilo mono e título com hierarquia tipográfica mais forte.
- Status, responsáveis e componentes alinhados sem deslocar a primeira coluna.
- Contagem de descendentes ocultos junto ao pai recolhido.
- Animação curta de altura/opacidade, removendo os descendentes da navegação por teclado e da árvore de acessibilidade.
- Estado de colapso separado por projeto; persistência fica para uma etapa posterior explícita.

## Fases de implementação

### 1. Motor de cena e foco explícito

Criar índices, estado, regras de contexto e cena estática sem animação. Substituir LOD global por `focusId + semanticLevel`.

### 2. Layout adaptativo e gestos

Implementar dimensões medidas, compressão por grupo, resumos laterais, arestas e enquadramento seguro. Separar wheel semântico de `Ctrl` + wheel geométrico.

### 3. FLIP e navegação acessível

Adicionar animações interrompíveis, entradas/saídas, breadcrumb, teclado, reduced motion e tooltips acessíveis.

### 4. Lista e hardening

Promover a lista D reescrita com os padrões de produção, medir árvores grandes, revisar frames e remover os protótipos e o switcher da aplicação principal.

## Matriz de aceite

Validar no Chrome com o seed e uma árvore gerada de mil tickets:

- Foco na raiz, em nível profundo e em folha.
- `semanticLevel` em 0, 0,5, 1, 1,5, 2, 2,5 e 3.
- Câmera de 8% a 160%, sem alteração semântica quando o modificador estiver ativo.
- Viewports de 1440 × 1000, 1280 × 720 e 390 × 844.
- Grupos com 1, 5, 20 e 100 irmãos.
- Interrupção rápida e reversão do zoom no meio da animação.
- Navegação somente por teclado e `prefers-reduced-motion`.
- Nenhuma sobreposição, aresta órfã, perda de seleção ou contagem divergente.
- Ausência de long tasks acima de 50 ms no fluxo típico do seed; investigar qualquer frame acima do orçamento de 16 ms antes de escalar o conjunto renderizado.

Repetir `pnpm lint`, `pnpm typecheck`, `pnpm build` e os fluxos HTTP existentes. A validação de UX deve incluir screenshots e inspeção de animações, não apenas compilação.

## Decisões que esta proposta evita

- Inferir foco continuamente da viewport por padrão.
- Usar `viewport.zoom` como sinônimo de nível semântico.
- Encolher toda a árvore até o texto ficar ilegível.
- Ocultar irmãos para caber na tela.
- Trocar cards por um novo conjunto com fade, sem preservar posição.
- Manter posições verticais fixas depois da compressão.
- Atualizar o estado do React a cada frame.
- Colocar Jev no caminho de execução de pan, zoom ou animação.
