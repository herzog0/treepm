# TreePM · engine espacial

Árvore genérica, engine espacial headless, componentes React estilizáveis e uma demonstração local com dados fictícios. A direção do projeto continua em [docs/vision.md](docs/vision.md), e as ideias ficam em [docs/ideas.yaml](docs/ideas.yaml). A plataforma futura está planejada em [product-blueprint.md](docs/product-blueprint.md); ainda não foi implementada.

## Rodar

Requisitos: Node **22.23.1** e pnpm **10.25.0**.

```bash
pnpm install
pnpm dev
```

Abra **http://localhost:5173**. O comando compila as bibliotecas e acompanha alterações na engine, nos componentes React e na demo.

Para compilar e servir a versão de produção localmente:

```bash
pnpm start
```

Abra **http://localhost:4173**. Para servir novamente a última build sem recompilar, use `pnpm preview`.

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
| `packages/react` | Componentes e hooks genéricos, gestos, renderers e estilos opcionais. |
| `apps/web/src/demo` | Dados fictícios determinísticos. |
| `docs` | Visão futura, decisões atuais e documentação da engine. |

A demo roda inteiramente no navegador, sem configuração de credenciais ou servidor de dados. A engine recebe um tipo genérico com `id` e `parentId`; não exige título, cor ou campos de negócio. Quadrados de filhos agrupados misturam cores por uma função substituível da apresentação, sem badge `+N`.

Exemplos de consumo, parâmetros e separação das camadas estão em [engine-usage.md](docs/engine-usage.md).

## Verificar

```bash
pnpm typecheck
pnpm lint
pnpm build
git diff --check
```

Ver [docs/platform-overview.md](docs/platform-overview.md) e [docs/architecture.md](docs/architecture.md).
