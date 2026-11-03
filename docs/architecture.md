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

O rótulo `doneLeaves de totalLeaves folhas concluídas · percent%` acompanha a cor e usa `role="progressbar"` no canvas. A cor nunca é o único canal.

## Cena semântica e gestos

A home usa a árvore semântica de `TreeCanvas.tsx`, implementada em DOM/SVG e integrada aos mesmos painéis, formulários e dados da aplicação. A biblioteca React Flow permanece no workspace, mas o canvas de produção não depende mais dela. O protótipo A DEV e a home compartilham duas unidades de apresentação, sem alterar o domínio:

- `semanticScene.ts`: contexto visível, cards completos/compactos/chips/dots/resumos, layout por dimensões reais, interpolação entre focos e cálculo da âncora do cursor.
- `useSemanticGestures.ts`: foco explícito, atenção progressiva, câmera, wheel, pan e controles de enquadramento.

`tidyTreeLayout` fornece tickets, profundidade e contagens. A cena recalcula X com as larguras efetivas e gaps adaptativos de 18–30 px, separa subárvores e centraliza pais sobre filhos visíveis. Y usa a maior altura real de cada nível mais 28–36 px. O foco e seus descendentes, ancestrais, irmãos e resumos laterais formam a cena; nenhum irmão é escondido para caber.

### Wheel e foco

- Wheel principal altera a semântica exatamente no ponto sob o cursor. Sobre um card, a posição relativa dentro dele é preservada; no fundo, preserva-se a coordenada de cena.
- `Ctrl`/`Meta` + wheel altera somente a escala geométrica, com a mesma âncora. `Shift` + wheel faz pan horizontal; os controles alteram semântica e enquadram o contexto.
- Mirar um card indica atenção sem mutar foco. Zoom+ sobre outro card progride entre as cenas do foco atual e do candidato; deltas adicionais invertem larguras e concluem a troca. Reverter o gesto antes da conclusão retoma o foco anterior. Wheel no fundo nunca escolhe um ticket arbitrário.
- Clique/Enter define foco e abre os detalhes do ticket. Pan, LOD e enquadramento não apagam seleção nem alteram `parentId`.

Cards e arestas são calculados a partir dos mesmos retângulos no mesmo render dirigido pelo gesto. Não há transições CSS independentes de `transform` e `d`, evitando dessincronia durante reversões. Nós que entram/saem convergem para o representante visível mais próximo; conexões cujos extremos não estão representados não são desenhadas.

### Pan e dependências

Botão esquerdo funciona no fundo e sobre cards; o do meio continua disponível. O gesto começa após 5 px, preservando clique. Pointer capture é adquirido somente nesse momento; `pointerup`, `pointercancel` e `lostpointercapture` limpam o estado sem restaurar ou saltar a câmera. Seleção/arraste nativo são prevenidos somente enquanto há um gesto ativo, e um pan suprime o click final.

Cards e o SVG das arestas compartilham uma wrapper de cena transladada imediatamente pela câmera. Cada `TicketEdge` conserva ID, seleção, cor, espessura e tracejado. Dependências são criadas pelo conector do card ou pelo fluxo do painel, nunca por mudança hierárquica. O modo `C`, o minimapa, o enquadramento e `prefers-reduced-motion` permanecem disponíveis.

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
