# TreePM — convenções para futuras sessões

## Sincronização de instruções

- Toda instrução adicionada ou alterada em `CLAUDE.md` deve ser adicionada ou alterada também em `AGENTS.md` na mesma interação, inclusive esta regra de sincronização.

## Registro de ideias

- Sempre que o usuário apresentar uma ideia concreta para o projeto, registre-a em `docs/ideas.yaml` na mesma interação. Se a ideia já existir, atualize-a em vez de criar uma duplicata.
- Use IDs sequenciais e estáveis no formato `IDEA-NNN`, datas no formato `YYYY-MM-DD` e preencha os campos seguindo as entradas existentes.
- Preserve o ID e a data original de cada ideia. Represente relações pelo ID da outra ideia, com um tipo como `related_to`, `depends_on` ou `refines`.
- Não transforme discussões apenas sobre o formato ou o processo de registro em novas ideias.

## Princípios

- A home `/` é uma **constelação espacial Prezi**, sem arestas top-down ou cards Kanban. `/legacy` preserva a experiência completa de árvore top-down, Lista e Kanban. Não reutilize `useSemanticGestures`/`semanticScene` na home espacial; mantenha hooks/layout/CSS próprios e bootstrap/API/`TreeIndex` compartilhados.
- Use `docs/platform-overview.md` como resumo navegável e `docs/adr/README.md` como índice das decisões duradouras. Preserve `docs/vision.md`; detalhes de implementação ficam em `docs/architecture.md` e só dúvidas reais em `docs/open-questions.md`. A direção A continua no legado com zoom ancorado e foco progressivo; `docs/semantic-zoom-proposal.md` mantém a avaliação histórica e as próximas evoluções, sem tratar C/D como views de produção.
- Na home espacial, cada geração é fisicamente menor e organizada em regiões retangulares determinísticas: filhos ficam abaixo do pai, com `ceil(sqrt(n))` colunas, linhas centralizadas, cards alinhados ao topo dos slots e envelopes disjuntos. Não retome anéis/ângulos nem transforme a home em grid plano; preserve zoom por geração, LOD full/compact/chip/dot, agregados e culling de viewport. O preenchimento por status começa ligado; `c`/`C` alterna esse preenchimento com wash superior e texto branco, mas nunca em modificadores, repeat ou edição. O botão Cores expõe `aria-pressed`.
- Na home, indicador e ticket são a mesma representação por ID: `spatialScene.ts` deriva translação e escala continuamente do zoom, com caminho reversível e sem fade do corpo. Não volte a desenhar quadradinhos duplicados sob pais cujos filhos já estão revelados. Culling considera a posição apresentada, e grupos `+N` reconciliam filhos que não cabem. A composição dos indicadores permanece estável e ajusta a escala continuamente; não use `floor` para trocar slots, cortes opacos por largura ou inserção de corpos com tamanho positivo na divisão de grupos. Os filhos seguintes aparecem como indicadores quando o pai ganha espaço; preserve o alcance de 140 px/full para todas as folhas.
- Zoom contínuo preserva exatamente o ponto mundial sob o cursor. Wheel normaliza `deltaMode`, usa ganho 0,0016 e acumula o alvo em coordenadas estáveis num único loop temporal, sem reiniciar a animação por delta; use a escala exibida e o tempo entre frames para aproximar o alvo, sem um easing que expire no meio de uma rajada. Mover o cursor recaptura somente a âncora, nunca descarta deltas acumulados. Novo pointerdown assume a câmera exibida imediatamente, cancelando o zoom/foco pendente sem esperar settle. Durante drag ativo, wheel e pan compõem: o delta incremental translada câmera, âncora e alvo do wheel juntos. Reduced motion aplica o alvo imediatamente. Clique simples abre detalhes sem mudar câmera, enquanto “Explorar ramo” e breadcrumb controlam mergulho; fit/reset centraliza `initialBounds`. Toda folha deve poder atingir 140 px: o máximo deriva de `max(6, 140 / menorLarguraNormalizada)` e, quando a leitura domina o fit, o foco centraliza o próprio alvo.
- As regras de compactação semântica, `WheelAnchor`, LOD e arestas abaixo pertencem ao legado. Domínio, API, progresso derivado, múltiplos responsáveis e segurança de dados continuam compartilhados entre as duas experiências.
- Não introduza owner único. Tickets e componentes aceitam múltiplos responsáveis.
- Somente folhas têm status manual. Progresso de pais deriva das folhas descendentes, com texto além de cor.
- Compactação semântica é bottom-up por altura da subárvore: folhas, depois pais e ancestrais. Não volte a usar profundidade absoluta ou esconder ramos sem agregado explícito e contagens reconciliadas.
- Wheel negativo sobre ticket compacta somente sua subárvore, de forma contínua e reversível: `fase = (1,40 − zoom)/0,12 − subtreeHeight + progressoLocal`. O alvo permanece como dot/agregado com indicadores imediatos; irmãos externos ficam intactos. Wheel+ reverte essa fase antes de retomar foco/expansão. Em fundo, a compactação global usa o mesmo bottom-up e mínimo dinâmico `min(0,50, 1,40 − (alturaMáxima + 4) × 0,12)` para terminar somente na raiz quando houver uma.
- Todo pai mantém indicadores dos filhos imediatos, inclusive como dot/agregado. Eles são prévias acessíveis, não nós contados duas vezes; microdots têm 6 px dentro de alvos de 20 px e agrupamento explícito quando necessário.
- O mouse é sempre a origem do zoom e do clique focalizado: preserve o ponto de card/indicador, a referência de borda próxima ou a cena crua sob o cursor em todos os frames. Em fundo livre, normalize essa referência no envelope visível e remapeie para o envelope relayoutado em vez de congelar o pixel lógico antigo; escala geométrica e câmera evoluem no mesmo rAF, sem fit/center. Seleção nunca recentraliza câmera; abrir/fechar o painel também usa a âncora do último ponteiro. Só use o centro como fallback acessível quando nunca houve ponteiro.
- Numa sessão curta com as **mesmas coordenadas**, preserve a `WheelAnchor` inteira — `kind`, `ticketId`, `sourceNodePresent`, `relativeX/Y`, referência local, cena e fallbacks — mesmo se uma animação colocar outro alvo sob o mouse parado. As decisões de foco usam `anchor.ticketId`, nunca o hit DOM acidental desse `samePoint`. Coordenadas novas capturam alvo explícito, borda de conteúdo a até 48 px ou cena crua somente no fundo livre, nunca seleção/foco/centro. Na agregação, transfira card→indicador→agregado pela média ponderada dos pontos dos representantes presentes. Depois do evento não há follow nem drag+wheel, com ou sem `Ctrl`/`Meta`; `Ctrl`/`Meta` altera somente escala geométrica.
- No legado, nenhum drag compõe pan durante wheel, independentemente do modificador; o zoom ancorado tem prioridade até a sessão expirar. Fora da sessão, drag normal usa deltas incrementais sem baseline antiga, nunca seguido de click acidental.
- `lostpointercapture` com botão pressionado não encerra drag nem wheel. Reaadquirir capture no próximo movimento; a supressão do click pós-drag persiste até ser consumida, limpa no próximo pointerdown intencional e permite ativação `detail=0`.
- Clique real no fundo e `Escape` fora de campos editáveis limpam ticket/aresta selecionados e fecham o painel, sem deselecionar após drag ou em controles. Interrupções fazem settle de cena/foco/câmera; `sceneOverride` e `is-attention` não podem ficar parciais ou residuais. Atenção só é retomada no próximo movimento real do mouse ou ao sair do stage.
- **Foco no clique** começa desligado: clique/Enter abre somente detalhes e preserva foco, LOD, cena e câmera. Quando ligado, o próximo clique usa o LOD estável de 104%, com identificador + título truncado e contexto bottom-up; alternar o toggle não move a cena. Breadcrumb continua foco explícito.
- Agregados homogêneos preservam a cor das folhas; combinações de status usam `mixed`/laranja na apresentação. Isso não altera `Ticket.status`, `getProgress` nem o estilo das arestas.
- Hierarquia e dependência são entidades/arestas distintas. Nunca altere `parentId` ao criar/remover dependência.
- Toda aresta tem estilo e seleção independentes; preserve seleção e evite edges órfãs nas transições de LOD.
- Validação de integridade pertence à API; regras puras reutilizáveis ficam em `packages/domain`.

## Stack e estilo

- Node **22.23.1**, pnpm **10.25.0**, workspaces, ESM e TypeScript estrito.
- React + Vite + `@xyflow/react` na web; Fastify + zod na API; React + Vite no admin.
- Imports relativos em código Node/TypeScript ESM usam extensão `.js`, inclusive entre arquivos `.ts`.
- Use `import type` para tipos e siga os padrões já existentes de componentes, CSS e repositório.
- Não presuma novas bibliotecas: instale e registre no manifest do workspace correto.
- Não exponha `TYPESAFE_API_KEY` no frontend. O SDK TypeSafe AI 0.7.0 pertence somente a `apps/api`.
- Não finja autenticação: usuários atuais são seed. Não exponha esta fatia como produção.

## Comandos

```bash
pnpm install
pnpm dev
pnpm typecheck
pnpm lint
pnpm build
```

API: `pnpm --filter @treepm/api dev` (porta 3001). Web: `pnpm --filter @treepm/web dev` (5173). Admin: `pnpm --filter @treepm/admin dev` (5174).

Antes de concluir mudanças, execute typecheck, lint, build e `git diff --check`. Exercite endpoints reais quando alterar API. Não crie suíte permanente sem alinhar uma mudança explícita de convenção; use harnesses CDP temporários para browser, gestos, overlaps, console e rotas, removendo esses artefatos após a validação. Não deixe processos dev rodando ao terminar e não faça commits a menos que o usuário peça.

## Dados e segurança

- O seed fica em `apps/api/src/seed.ts`.
- JSON gerado fica em diretório ignorado pelo Git; configure `TREEPM_DATA_FILE` quando necessário.
- Escritas locais passam por `JsonTreeRepository` com fila e rename atômico. Produção requer outra implementação de `TreeRepository` com banco transacional.
- Não leia nem copie `.env`; use apenas `apps/api/.env.example` para documentar variáveis sem segredo.
- Exclusão de subárvore exige `recursive=true` e confirmação explícita na UI. Preserve esse comportamento seguro.
