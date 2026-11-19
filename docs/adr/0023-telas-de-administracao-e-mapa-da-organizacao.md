# ADR 0023 — Telas de administração e mapa da organização

**Status:** Aceita. **Data:** 2026-11-19.

## Contexto

A API da Fase 1 ([domain-model.md](../domain-model.md)) está pronta, mas a web só chama `GET /api/me` e mostra a demo fictícia depois do login. A Fase 1 só fecha quando alguém cria time, área e projeto e concede acesso pela interface.

Teodoro decidiu em 2026-11-19:

- **Times** ficam em uma área dedicada, fora do mapa.
- **Áreas** (que ele chama de workspaces) e **projetos** ficam em um painel lateral sobre o mapa.
- Depois do login, o mapa deixa de mostrar a demo: a organização vira a raiz e os projetos visíveis viram os primeiros nós. Esse é o pedido explícito que autoriza mexer no que aparece no mapa; os gestos e o comportamento da câmera não mudam.

## Decisão

### Navegação

A SPA continua sem biblioteca de rotas. O destino é um parâmetro de consulta, como na [ADR 0020](0020-fluxo-do-clerk-na-spa.md), e o hash continua reservado ao Clerk.

- Sem parâmetro `view`: o mapa.
- `?view=teams`: a área dedicada de times.

A troca usa `history.pushState` e responde a `popstate`, de modo que voltar e avançar do navegador funcionam. O cabeçalho ganha a navegação entre Mapa e Times. O painel lateral é estado do mapa, não é destino de URL.

### Mapa da organização

O mapa autenticado recebe uma árvore montada a partir da API: a raiz é a organização de `GET /api/me` e cada projeto de `GET /api/projects` é um filho direto. Projetos arquivados não aparecem. Não há mudança em `packages/engine` nem em `packages/react`; a web só troca os itens e os adaptadores de rótulo e cor.

Uma organização sem projetos mostra a raiz sozinha e uma ação visível para criar o primeiro projeto, quando o papel permite.

`?demo` continua igual e não chama a API.

### Painel lateral

O painel é uma sobreposição dentro do mapa, à direita, com a mesma linguagem visual do cartão de seleção da demo. Ele tem duas partes:

- **Áreas:** lista, criação, renomeação e remoção.
- **Projetos:** lista, criação e, ao selecionar um projeto (pela lista ou pelo nó no mapa), o detalhe com nome, visibilidade, arquivamento, pessoas com papel e times associados.

O painel não deixa eventos de ponteiro, roda ou teclado chegarem ao mapa: rolar a lista não dá zoom, e digitar em um campo não aciona atalhos.

### Área de times

A tela `?view=teams` lista os times e, para o time aberto, os membros com seus papéis. Permite criar, renomear e remover time, e incluir, promover e remover membros, conforme a matriz de permissões.

### Cliente da API e estado

`apps/web/src/api` ganha um cliente tipado que recebe `getToken` e `fetch` por parâmetro, como `fetchMe` já faz, e devolve um resultado discriminado em vez de lançar exceção. As respostas são validadas antes de entrar no estado.

Não há biblioteca de cache. Cada tela carrega o que usa e recarrega depois de uma mutação bem-sucedida. Todo o estado derivado da API vive abaixo de um componente com `key={orgId}`, de modo que trocar de organização descarta tudo e busca de novo.

### Permissões e erros na interface

As ações aparecem só para quem pode executá-las, a partir dos papéis de `GET /api/me`. Isso é conveniência: a API continua sendo quem decide.

Os códigos de erro da API (`team_name_taken`, `area_name_taken`, `project_key_taken`, `person_inactive`, 403 e 404) viram mensagens em português junto do campo ou da ação que falhou.

### Testes

A web passa a ter testes de componente (Vitest com jsdom e Testing Library), além dos testes de função. Os componentes recebem o cliente da API por parâmetro, e os testes usam um cliente falso.

## Consequências

- A web deixa de ser só casca de login e passa a ter estado de servidor; sem cache, cada mutação custa uma releitura.
- O painel lateral e a área de times duplicam na interface as regras de permissão do servidor, só para esconder ações. Uma divergência não abre acesso, mas pode mostrar um botão que devolve 403.
- A verificação automatizada usa cliente falso. O comportamento com sessão real do Clerk depende de teste manual, pedido à coordenação operacional pela issue #1.
- A aparência das telas não foi desenhada por Teodoro; os fluxos e esboços ficam no board do Whimsical como `PROPOSTO` até ele revisar.
