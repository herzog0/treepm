# TreePM · engine espacial

Base mínima para reconstruir o TreePM: uma engine de hierarquia espacial e uma demonstração local com dados fictícios. A direção do projeto continua em [docs/vision.md](docs/vision.md), e as ideias futuras ficam em [docs/ideas.yaml](docs/ideas.yaml).

## Rodar

Requisitos: Node **22.23.1** e pnpm **10.25.0**.

```bash
pnpm install
pnpm dev
```

Abra **http://localhost:5173**. O comando compila a engine e acompanha alterações tanto nela quanto na demo.

## Navegação

- Wheel aproxima ou afasta mantendo a âncora do cursor.
- Botão esquerdo ou do meio arrasta o mapa. Um novo arraste responde imediatamente após zoom.
- Wheel durante drag combina os dois gestos.
- Os indicadores dos filhos se deslocam e crescem até virar os próprios cards; zoom reverso percorre o mesmo caminho.
- Clique seleciona um nó. **Explorar** e breadcrumb fazem o foco explícito; reset restaura a visão inicial.
- **C** ou **Cores** alterna preenchimento. O modo preenchido começa ativo.

## Estrutura

| Local | Responsabilidade |
| --- | --- |
| `packages/engine` | Modelos genéricos, índice hierárquico, layout, projeção da cena e matemática da câmera. |
| `apps/web/src/canvas` | Renderização React, estilos do fundo e controles de navegação. |
| `apps/web/src/demo` | Dados fictícios determinísticos. |
| `docs` | Visão futura, decisões atuais e documentação da engine. |

A demo roda inteiramente no navegador, sem configuração de credenciais ou servidor de dados. A engine recebe nós com `id`, `parentId`, `label` e `color`; não conhece regras de negócio.

## Verificar

```bash
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Ver [docs/platform-overview.md](docs/platform-overview.md) e [docs/architecture.md](docs/architecture.md).
