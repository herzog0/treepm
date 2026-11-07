# TreePM — convenções para futuras sessões

## Sincronização de instruções

- Toda instrução adicionada ou alterada em `CLAUDE.md` deve ser adicionada ou alterada também em `AGENTS.md` na mesma interação, inclusive esta regra de sincronização.

## Base atual

- O workspace contém `packages/engine`, `packages/react` e `apps/web`. A engine é genérica; React e estilos são uma camada opcional, e a demo usa dados fictícios locais. O blueprint em `docs/product-blueprint.md` planeja a plataforma futura; não o trate como produto já implementado.
- A ideia do TreePM permanece em `docs/vision.md`; `docs/ideas.yaml` registra intenções futuras. Documentação da base em `docs/platform-overview.md`, detalhes em `docs/architecture.md` e decisões atuais em `docs/adr/README.md`.
- `@treepm/engine` é TypeScript ESM puro e não importa React. `TreeNode` combina interfaces de identidade e parentesco (`id`, `parentId`); o tipo genérico concreto do consumidor atravessa índice, layout e cena. Não exija título, cor, status ou campos de ticket no contrato headless. Opções tipadas parametrizam layout, cena e câmera.
- O índice valida IDs únicos, pais existentes e ausência de ciclos. A ordem de entrada define a ordem dos irmãos. Não esconda erros estruturais com um fallback silencioso.
- React, eventos do navegador, pointer capture, renderers e CSS opcionais ficam em `packages/react`. Conteúdo, cores, mistura, slots, classes e tokens são substituíveis. `apps/web/src/demo` é um consumidor com tipo e dataset determinísticos próprios; não depende de HTTP, credenciais, persistência ou sorteio em cada render. Preserve isolamento de atalhos e estilos entre múltiplas instâncias.

## Geometria e navegação

- Preserve o fundo espacial e a experiência Prezi. Cada geração é fisicamente menor, com filhos abaixo do pai, `ceil(sqrt(n))` colunas, linhas centralizadas, cards alinhados pelo topo e envelopes disjuntos. Não retome anéis, ângulos ou uma grade plana.
- Indicador e card são a mesma representação por ID. A cena deriva translação e escala continuamente do zoom, com caminho reversível e sem fade do corpo. Culling usa as posições apresentadas, inclusive durante a transformação.
- Preserve LOD full/compact/chip/dot. Filhos são particionados em até `maxSlots` buckets contíguos e balanceados; grupos são quadradinhos mesclados, sem badge `+N`. Membership e contagens acessíveis devem reconciliar todos os filhos sem duplicação semântica no repouso. A mistura de cores é função substituível da apresentação, nunca regra do índice headless. A linha é estável e se ajusta por escala contínua; não use cortes opacos nem insira corpos já grandes ao separar grupos.
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

## Delegação e executores

- A sessão coordenadora (Claude Fable) escreve briefs, revisa diffs, roda as verificações e faz os commits. A implementação é delegada a executores em panes do herdr, um por tarefa, em aba própria e sem roubar o foco do pane principal.
- Ordem de preferência (ranking provisório de 2026-11-07, recalibrar comparando dois executores na mesma tarefa): Codex `gpt-6.1-sol` para TypeScript difícil, geometria, perf e gestos; Kimi `k3.1-pro` para refatorações multi-arquivo, docs e contexto grande; modelos gratuitos do OpenCode `opencode/deepseek-v4.1-flash-free`, `glm-5.3-flash-free`, `big-pickle` e `mimo-v2.6-flash-free` para testes, scaffolding, refatorações mecânicas e lint; `nemotron-3.5-super-vl-free` para verificações com screenshot. Outros modelos Claude só como último recurso.
- Cota: só `opencode/*-free` é gratuito. Não rodar Kimi por dentro do OpenCode (`kimi-code-plan-global/*`) e não usar `k3.1-pro-highspeed` (custo dobrado). Não usar modelos locais (Ollama) em nenhuma CLI.
- Modo não assistido: `-y` no Kimi, `--auto` no OpenCode, `--approve-for-me` no Codex. Forçar modelo no OpenCode: `OPENCODE_CONFIG_CONTENT='{"model":"opencode/<modelo>"}' opencode --standalone`. Headless para tarefas pequenas: `codex exec`, `kimi -p`, `opencode run -m`.
- Executores trabalham em branch ou worktree próprios e não fazem commit. Em 2026-11-07 Teodoro autorizou a coordenação a criar branches, worktrees, panes e commits locais à vontade; push e deploy continuam dependendo de autorização explícita.
