# TreePM — convenções para futuras sessões

## Princípios

- A **árvore top-down é a visão principal**. Lista e Kanban são secundárias.
- Preserve `docs/vision.md`; registre decisões técnicas em `docs/architecture.md` e só deixe dúvidas reais em `docs/open-questions.md`. A direção A já está incorporada à home com zoom ancorado e foco progressivo; `docs/semantic-zoom-proposal.md` mantém a avaliação histórica e as próximas evoluções, sem tratar C/D como views de produção.
- Não introduza owner único. Tickets e componentes aceitam múltiplos responsáveis.
- Somente folhas têm status manual. Progresso de pais deriva das folhas descendentes, com texto além de cor.
- Compactação semântica é bottom-up por altura da subárvore: folhas, depois pais e ancestrais. Não volte a usar profundidade absoluta ou esconder ramos sem agregado explícito e contagens reconciliadas.
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

Antes de concluir mudanças, execute typecheck, lint e build. Exercite endpoints reais quando alterar API. Não crie testes automatizados sem alinhar uma mudança explícita de convenção; o repositório ainda não tem suíte. Não deixe processos dev rodando ao terminar e não faça commits a menos que o usuário peça.

## Dados e segurança

- O seed fica em `apps/api/src/seed.ts`.
- JSON gerado fica em diretório ignorado pelo Git; configure `TREEPM_DATA_FILE` quando necessário.
- Escritas locais passam por `JsonTreeRepository` com fila e rename atômico. Produção requer outra implementação de `TreeRepository` com banco transacional.
- Não leia nem copie `.env`; use apenas `apps/api/.env.example` para documentar variáveis sem segredo.
- Exclusão de subárvore exige `recursive=true` e confirmação explícita na UI. Preserve esse comportamento seguro.
