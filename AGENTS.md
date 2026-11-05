# TreePM — convenções para futuras sessões

## Sincronização de instruções

- Toda instrução adicionada ou alterada em `CLAUDE.md` deve ser adicionada ou alterada também em `AGENTS.md` na mesma interação, inclusive esta regra de sincronização.

## Registro de ideias

- Sempre que o usuário apresentar uma ideia concreta para o projeto, registre-a em `docs/ideas.yaml` na mesma interação. Se a ideia já existir, atualize-a em vez de criar uma duplicata.
- Use IDs sequenciais e estáveis no formato `IDEA-NNN`, datas no formato `YYYY-MM-DD` e preencha os campos seguindo as entradas existentes.
- Preserve o ID e a data original de cada ideia. Represente relações pelo ID da outra ideia, com um tipo como `related_to`, `depends_on` ou `refines`.
- Não transforme discussões apenas sobre o formato ou o processo de registro em novas ideias.

## Base atual

- O workspace contém somente `packages/engine` e `apps/web`. A engine é genérica; a demo usa dados fictícios locais. Não reintroduza modelos ou telas de produto sem uma nova solicitação explícita.
- A ideia do TreePM permanece em `docs/vision.md`; `docs/ideas.yaml` registra intenções futuras. Documentação da base em `docs/platform-overview.md`, detalhes em `docs/architecture.md` e decisões atuais em `docs/adr/README.md`.
- `@treepm/engine` é TypeScript ESM puro e não importa React. Sua entrada é `SpatialItem` com `id`, `parentId`, `label` e `color`. Relações, profundidades, alturas, contagens, layout, cena e matemática da câmera pertencem ao pacote.
- O índice valida IDs únicos, pais existentes e ausência de ciclos. A ordem de entrada define a ordem dos irmãos. Não esconda erros estruturais com um fallback silencioso.
- React, eventos do navegador, pointer capture e CSS ficam em `apps/web/src/canvas`. O dataset determinístico fica em `apps/web/src/demo`; não depende de HTTP, credenciais, persistência ou sorteio em cada render.

## Geometria e navegação

- Preserve o fundo espacial e a experiência Prezi. Cada geração é fisicamente menor, com filhos abaixo do pai, `ceil(sqrt(n))` colunas, linhas centralizadas, cards alinhados pelo topo e envelopes disjuntos. Não retome anéis, ângulos ou uma grade plana.
- Indicador e card são a mesma representação por ID. A cena deriva translação e escala continuamente do zoom, com caminho reversível e sem fade do corpo. Culling usa as posições apresentadas, inclusive durante a transformação.
- Preserve LOD full/compact/chip/dot e grupos `+N` com contagens explícitas. A linha de indicadores tem composição estável e se ajusta por escala contínua. Não use cortes opacos por largura nem insira corpos já grandes ao separar grupos.
- Cores são atributos visuais da entrada. O preenchimento começa ligado; C/Cores alterna com wash superior e texto legível. Modificadores, repeat e edição não disparam o atalho. O controle expõe `aria-pressed`.
- Wheel normaliza `deltaMode`, usa ganho 0,0016 e acumula o alvo em um único rAF. Use a escala exibida e o tempo entre frames, sem um easing que expire no meio de uma rajada. Mover o ponteiro recaptura só a âncora, sem perder deltas.
- Novo pointerdown assume a câmera exibida imediatamente, cancelando animação pendente sem salto ou cooldown. Durante drag, o delta incremental translada câmera, âncora e alvo do wheel juntos. Movimento reduzido aplica destinos imediatamente.
- O máximo de zoom deriva de `max(6, 140 / menorLarguraNormalizada)`. Toda folha deve poder alcançar 140 px/full. Foco explícito centraliza o próprio alvo quando sua leitura exige mais escala que o fit do ramo. Reset centraliza `initialBounds`.
- Clique seleciona sem mover a câmera; Explorar e breadcrumb fazem foco explícito. Fundo/Escape limpam seleção. O click pós-drag é suprimido, mas o próximo pointerdown intencional e ativação `detail=0` continuam funcionando.
- Perda de pointer capture com botão pressionado não encerra drag nem wheel; readquirir no próximo movimento. Sem botão pressionado não há pan ou acompanhamento da câmera. Bloquear drag nativo de imagens e seleção acidental de texto no mapa.

## Stack e verificação

- Node **22.23.1**, pnpm **10.25.0**, workspaces, ESM e TypeScript estrito. A demo usa React + Vite.
- Imports relativos TypeScript/Node usam extensão `.js`. Use `import type` e tipos explícitos nas fronteiras públicas. Não acrescente bibliotecas sem necessidade e manifest correspondente.
- `pnpm dev` acompanha engine e demo; o site usa a porta 5173. `pnpm typecheck`, `pnpm lint`, `pnpm build` e `git diff --check` são obrigatórios antes de concluir mudanças.
- Use harnesses temporários para validar geometria, gestos, overlaps, console e viewport no navegador. Não adicione uma suíte permanente sem alinhar a convenção; remova artefatos de diagnóstico ao terminar.
- Pare somente processos de teste iniciados por você. Não leia nem copie `.env` e não inclua segredos no Git.
- Use Git para mudanças revisáveis e reversíveis. Na refatoração atual, o usuário autorizou uma branch, um checkpoint anterior à limpeza e um commit separado para a extração da engine. Não reescreva história, não faça push e não inclua trabalho alheio em commits sem autorização.
