# Arquitetura da primeira fatia

## Workspace e fronteiras

```text
packages/domain     Tipos e funções puras: árvore, progresso, ciclos e layout
apps/api            Fastify + zod + repositório + classificador Jev
apps/web            React + Vite; árvore semântica DOM/SVG, Lista, Kanban e formulários
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

## Cena semântica e gestos

A home usa a árvore semântica de `TreeCanvas.tsx`, implementada em DOM/SVG e integrada aos mesmos painéis, formulários e dados da aplicação. A biblioteca React Flow permanece no workspace, mas o canvas de produção não depende mais dela. O protótipo A DEV e a home compartilham duas unidades de apresentação, sem alterar o domínio:

- `semanticScene.ts`: contexto visível, compactação bottom-up, agregados e cores, layout por dimensões reais, interpolação e âncora do cursor.
- `useSemanticGestures.ts`: foco explícito, atenção progressiva, câmera, wheel, pan e controles de enquadramento.

`tidyTreeLayout` fornece tickets, profundidade e contagens. A cena recalcula X com as larguras efetivas e gaps adaptativos de 18–30 px, separa subárvores e centraliza pais sobre filhos visíveis. Y usa a maior altura real de cada nível mais 28–36 px. O foco e seus descendentes, ancestrais, irmãos e resumos laterais formam a cena; nenhum irmão é escondido para caber.

### Compactação bottom-up e agregação

Cada nó tem `subtreeHeight`: folha vale 0; um pai vale 1 mais a maior altura dos filhos. A fase global é `(1,40 − zoom) / 0,12`, e a fase local subtrai essa altura, com tolerância de `1e-9` para estabilidade de ponto flutuante. As fases produzem `full → compact → chip → dot → agregado`, com dimensões contínuas dentro de cada faixa. Assim todas as folhas se reduzem antes dos pais, independentemente da profundidade absoluta ou do balanceamento do ramo.

Na fase de agregação, o descendente deixa de ser um nó independente e seu pai conserva identidade, tooltip, nome acessível, folhas concluídas/total e contagem de descendentes. `representedCount` reconcilia os tickets representados pela cena: a soma permanece igual ao total do projeto. Todo pai também mantém uma linha de indicadores dos filhos imediatos, mesmo quando já é dot/agregado. Essas prévias não entram novamente na soma nem criam arestas duplicadas; usam status, tooltip e acesso por teclado. Acima de oito filhos, seis individuais e grupos explícitos por status limitam a largura. Um indicador comum mede 10 px; o filho de um dot usa microdot de 6 px, sempre dentro de um alvo interativo de 20 px. O layout reserva a largura/altura da linha para evitar colisões.

O estado semântico inicial é 1,28; os limites 0,50–1,40 permitem agregar camadas até a visão do projeto. Com **Foco no clique** ligado, o clique usa o LOD estável **1,04** (`1,40 − 3 × 0,12`). Cards textuais viram chips com identificador e início do título em uma linha com reticências; folhas na fase correspondente viram dots e o contexto continua bottom-up. No dataset atual, isso representa o foco e até três gerações de chips antes dos dots, sem impor profundidade absoluta.

### Wheel e foco

- O mouse é sempre a origem `(0,0)` da expansão/contração. Sobre card, preserva-se a posição relativa; sobre microindicador, preserva-se esse indicador; no fundo, preserva-se a coordenada crua de cena. A regra é idêntica com ou sem ticket selecionado: a seleção muda detalhe do ramo, nunca puxa a câmera para o selecionado ou para o centro. A âncora registra explicitamente `kind: card | indicator | scene` para não confundir um microindicador com o card que representa o mesmo ticket.
- Cada wheel inicia uma sessão curta. Enquanto ativa, `pointermove` atualiza `anchor.cursorX/Y` e `cameraForAnchor` no mesmo `flushSync`, fazendo auto-pan inclusive perto das bordas. Cada movimento válido rearma o timeout: a sessão expira após **240 ms sem wheel e sem movimento**, nunca segue o mouse indefinidamente e também funciona com reduced motion. Sair do stage congela o follow até um novo wheel; `fitContext`, foco e Shift+wheel encerram a sessão sem restaurar câmera antiga.
- Se o card de origem agrega, a âncora transfere continuamente para o indicador que representa o mesmo ticket, não para o selecionado, pai arbitrário ou centro. O cálculo inclui o border-bottom da containing block, alinhando solver e subpixels do DOM.
- `Ctrl`/`Meta` + wheel altera somente escala com a mesma âncora. `Shift` + wheel faz pan horizontal. Os botões `+`/`−` usam a última posição conhecida do mouse dentro do canvas; o centro é apenas fallback acessível quando nunca houve ponteiro. `deltaMode` normaliza pixels, linhas de 16 px e páginas. `fitContext` é ação explícita separada e pode enquadrar.
- Mirar um card indica atenção sem mutar foco. Zoom+ sobre outro card progride entre as cenas do foco atual e do candidato, mesmo se outro ticket estiver selecionado; zoom-out nunca troca foco para estabilizar a câmera. Reverter antes da conclusão retoma o foco anterior. Wheel no fundo não escolhe ticket arbitrário.
- **Foco no clique** começa desligado. Nesse modo, clique/Enter em card ou indicador apenas seleciona/abre detalhes, sem mudar foco, LOD, cena ou câmera. Ligado, o próximo clique usa o LOD 1,04 e a transição ancorada. Alternar o toggle não faz reset nem recentro; breadcrumb continua sendo foco explícito. Pan, LOD e enquadramento não apagam seleção nem alteram `parentId`.

Cards e arestas são calculados a partir dos mesmos retângulos no mesmo frame. Não há transições CSS independentes de `transform`, `d` ou cor semântica. Durante a transferência, larguras, alturas, opacidades e cores são interpoladas e a união das duas cenas passa por um novo layout completo: coordenadas nunca são interpoladas isoladamente, pois isso permitiria colisões. Nós que entram expandem a partir de dot e nós que saem comprimem até o agregado, permanecendo representados e sem usar opacidade para esconder colisões. Conexões cujos extremos não estão representados não são desenhadas; estilos persistidos das arestas não mudam.

### Animação coordenada de zoom e foco

Wheel semântico, `Ctrl`/`Meta` + wheel e os controles `+`/`−` usam **180 ms** com `easeOutCubic`. Um primeiro tick cancelável por `setTimeout(0)` publica feedback com `flushSync`; os demais frames usam `requestAnimationFrame` para atualizar progresso, câmera, dimensões, posições, opacidades, cores e arestas em conjunto. A âncora é recalculada pelos retângulos relayoutados em cada frame, inclusive durante a transferência filho→agregado.

Cada scroll captura a cena visual corrente em `fromScene`, inclusive retângulos e opacidades de uma animação em andamento. O destino lógico é mantido separadamente e acumula os deltas, de modo que bursts e reversões não percam intenção nem reiniciem da cena abstrata anterior. Um novo evento cancela o timeout/rAF anterior e retoma da geometria exibida, sem fila nem callbacks obsoletos. O estado final equivale à sequência de deltas aplicada diretamente.

Clique focalizado e wheel compartilham `startAnchoredAnimation`: cada frame calcula a câmera com `cameraForAnchor`, inclusive no estado final e em `prefers-reduced-motion`. Clique/breadcrumb usa **220 ms** e easing simétrico; wheel/controles usam 180 ms. O painel abre imediatamente, mas o `ResizeObserver` não recentraliza nem desloca a câmera para o foco: durante uma animação, o próximo frame resolve a nova largura; em repouso, recalcula a câmera pela última âncora do ponteiro. Pan e `Shift` + wheel continuam manipulação direta, sem easing. Movimento reduzido aplica imediatamente o estado final preservando o mesmo ponto.

### Pan e dependências

Botão esquerdo funciona no fundo e sobre cards; o do meio continua disponível. O gesto começa após 5 px, preservando clique. O drag guarda `lastX/Y`, não uma baseline antiga de câmera. Com sessão de wheel, o follow realiza o pan; sem sessão, cada pointermove soma somente seu delta à câmera atual. Assim drag real e wheel compartilham o frame sem cancelamento nem dupla contagem. Animação de foco, não de wheel, é cancelada ao iniciar pan.

Pointer capture é adquirido no threshold e readquirido se `lostpointercapture` chegar com botão pressionado; esse evento não encerra o drag nem o zoom. `pointerup`, `pointercancel` ou `buttons=0` limpam o estado. A supressão do click pós-drag não usa timer: permanece até o click ser consumido, é limpa no próximo pointerdown intencional e permite ativação por teclado/programação com `detail=0`. Seleção/arraste nativo são prevenidos somente durante o gesto.

Cards e o SVG das arestas compartilham uma wrapper de cena transladada imediatamente pela câmera. Cada `TicketEdge` conserva ID, seleção, cor, espessura e tracejado. Dependências são criadas pelo conector do card ou pelo fluxo do painel, nunca por mudança hierárquica. O modo `C`, o minimapa, o enquadramento e `prefers-reduced-motion` permanecem disponíveis.

Na revisão do dataset com 36 tickets, clique/resize passou de 156,18 px de deriva para no máximo 0,58 px; agregação terminou em 0,071 px e os frames verificados tiveram zero overlaps e arestas com erro de até 0,016 px. Wheel off-center/bursts/trackpad ficou abaixo de 0,712 px e `Ctrl`+wheel abaixo de 0,284 px. Ao atingir 140% sobre o candidato, a transferência conclui na mesma animação, sem deixar atenção pendente no teto; reversão antes do teto restaura o foco anterior. Em 390 × 844, os dois toggles ocupam o toolbar sem sobreposição e `scrollWidth=390`.

Na revisão de liberdade de navegação, wheel seguido de movimento de 160 × 80 px tinha 178,885 px de erro e foi abaixo de 0,001 px na matriz própria; o harness independente mediu até 0,933 px por arredondamento de coordenadas. Drag com wheel recuperou os 100 px de pan perdidos, manteve o LOD e não abriu painel. Card, fundo, indicador, borda, Ctrl+wheel, reduced motion, Shift, fit e timeout passaram; após 240 ms de inatividade, movimento adicional não altera a câmera.

Evidências: [follow durante wheel](assets/semantic-zoom/wheel-pointer-follow.png), [drag durante wheel](assets/semantic-zoom/drag-during-wheel.png), [LOD de clique a 104%](assets/semantic-zoom/click-context-104.png), [modo C e título truncado](assets/semantic-zoom/click-context-color-104.png), [agregado misto com microdots](assets/semantic-zoom/mixed-microdots-92.png), [toolbar mobile na home](assets/semantic-zoom/mobile-toolbar-home.png) e [na referência A](assets/semantic-zoom/mobile-toolbar-variant-a.png).

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

A fatia não contém suíte de testes por decisão explícita. `pnpm typecheck`, `pnpm lint`, `pnpm build` e chamadas reais à API são os portões mínimos. Web/admin são validados por compilação e consumo de endpoints; não há teste automatizado de browser nem validação online de Jev sem uma credencial real.
