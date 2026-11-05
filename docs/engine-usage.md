# Consumir a árvore e a experiência espacial

## Camadas

| Entrada | Responsabilidade |
| --- | --- |
| `@treepm/engine` | TypeScript puro: contratos da árvore, validação, índice, layout, cena e matemática de câmera |
| `@treepm/react` | Componentes e hooks de navegador: gestos, seleção, foco, conteúdo e apresentação |
| `@treepm/react/styles.css` | Estilos padrão opcionais; o consumidor pode sobrescrever tokens/classes ou fornecer os seus |
| `apps/web` | Um consumidor de exemplo, com dados e conteúdo próprios |

Nenhuma dessas camadas conhece tickets, usuários, Clerk ou Jev. A árvore não exige React, DOM, rótulo, cor ou formato de payload de negócio.

## Tipo definido pelo consumidor

O contrato mínimo separa identidade e parentesco. Um domínio estende `TreeNode`, que combina `TreeNodeIdentity` e `TreeNodeHierarchy`. Os campos adicionais continuam tipados no índice, layout, cena, callbacks e renderer.

```ts
import { buildTreeIndex, buildSpatialLayout, buildSpatialScene } from "@treepm/engine";
import type { TreeNode } from "@treepm/engine";

interface ServiceNode extends TreeNode {
  readonly name: string;
  readonly risk: number;
  readonly kind: "system" | "service";
}

const services: readonly ServiceNode[] = [
  { id: "platform", parentId: null, name: "Plataforma", risk: 1, kind: "system" },
  { id: "billing", parentId: "platform", name: "Cobrança", risk: 3, kind: "service" },
];

const index = buildTreeIndex(services);
const layout = buildSpatialLayout(index, {
  dimensions: (node, depth) => ({
    width: node.kind === "system" ? 250 : 150 / Math.max(1, depth),
    height: 100 / Math.max(1, depth),
  }),
  rootGap: 160,
});
const scene = buildSpatialScene(layout, index,
  { x: 400, y: 40, scale: 1 },
  { width: 800, height: 600 },
  { maxSlots: 6, fullWidth: 140, compactWidth: 70, chipWidth: 30 });

const risk: number | undefined = scene.nodes[0]?.node.item.risk;
```

Não é necessário converter o domínio para um tipo que contenha apenas os campos mínimos nem recuperar o tipo depois com casts. `buildSpatialIndex` e `SpatialTreeIndex` são aliases de migração dos contratos genéricos; `SpatialItem` também é apenas um alias estrutural mínimo.

O índice rejeita IDs duplicados, pai inexistente, autorreferência e ciclos. Aceita uma floresta, incluindo entrada vazia, e preserva a ordem dos irmãos. Layout e índice são snapshots `readonly`; alterar os dados significa criar nova entrada e reconstruí-los. Mutação interna por fora do contrato não é suportada pelo cache.

## Apresentação React

```tsx
import { SpatialCanvas } from "@treepm/react";
import type { RenderNodeContent } from "@treepm/react";
import "@treepm/react/styles.css";

const getLabel = (node: ServiceNode) => node.name;
const getColor = (node: ServiceNode) => node.risk >= 3 ? "#b94361" : "#21865e";
const renderContent: RenderNodeContent<ServiceNode> = ({ node, lod }) =>
  lod === "dot" ? null : <strong>{node.name}{lod === "full" && ` · risco ${node.risk}`}</strong>;

export function ServiceMap() {
  return <div style={{ height: 600 }}>
    <SpatialCanvas items={services} getLabel={getLabel} getColor={getColor}
      renderNodeContent={renderContent}
      onSelectionChange={(node) => { /* node é ServiceNode | null */ void node; }}
      style={{ "--spatial-background": "#111827", "--spatial-selection-ring": "#fbbf24" }} />
  </div>;
}
```

O container deve ter altura definida. Sem adaptador de rótulo, usa o ID. Sem adaptador de cor, usa a cor padrão da apresentação. Os controles padrão são opcionais (`controls={false}`), os rótulos são substituíveis e os slots `renderContext`, `renderOverlay` e `renderControls` recebem o controller tipado.

Para comandar seleção e câmera fora dos slots, combinar `useSpatialCanvas(options)` e `SpatialCanvasView controller={controller}`. `selectNode(id)` seleciona sem navegar; `focusNode(id)` navega explicitamente. O consumidor pode compor os dois comandos para um resultado de busca ou roteiro. `selectedId` e `onSelectionChange` permitem seleção controlada; `defaultSelectedId` oferece o padrão não controlado.

## Mistura dos quadrados agrupados

Filhos diretos são particionados em até `maxSlots` buckets contíguos e balanceados. Com 13 filhos e oito slots, os tamanhos são `2,2,2,2,2,1,1,1`. Os IDs de todos os filhos aparecem exatamente uma vez nessa partição. Um bucket com vários membros aparece como um quadradinho mesclado, sem texto `+N`; sua identificação acessível conserva a contagem e os membros.

A engine produz identidade, membership e geometria do grupo. A apresentação chama a função de mistura, sem atribuir significado de domínio à cor:

```tsx
import { mixIndicatorColors, SpatialCanvas } from "@treepm/react";
import type { MixColors } from "@treepm/react";

const mixByRisk: MixColors<ServiceNode> = (colors, members) =>
  mixIndicatorColors(colors.map((sample, index) => ({
    color: sample.color,
    weight: Math.max(1, members[index]?.risk ?? 1),
  })));

// <SpatialCanvas items={services} getLabel={getLabel} getColor={getColor}
//   mixColors={mixByRisk} />
```

O mixer padrão calcula média ponderada em RGB linearizado e retorna sRGB hexadecimal. Aceita `#rgb` e `#rrggbb` opacos, pesos positivos e finitos e ao menos uma amostra. Cores equivalentes homogêneas preservam a primeira representação fornecida. Para outros formatos, alpha, cores CSS ou outra semântica, fornecer um callback próprio que devolva a cor final. Mistura é calculada por membership/aparência, não repetida em cada frame de câmera.

Na expansão, o grupo encolhe e os membros se separam/crescem a partir de seu slot. Na volta, a composição é a mesma. Não existe um novo nó de domínio chamado grupo; são representantes visuais dos membros existentes.

## Parâmetros e estilos

| Fronteira | Opções |
| --- | --- |
| Layout | Dimensões por geração ou callback tipado, distância entre raízes, gaps e normalização |
| Cena | Limiares de LOD, revelação, translação, crescimento, separação, previews, conteúdo, slots, tamanho/gap de indicadores e margem de culling |
| Câmera | Ganho do wheel, escala mínima/máxima, largura de leitura, duração de foco, threshold de pan, passo e resposta temporal; override de movimento reduzido |
| Conteúdo | `getLabel`, `getColor`, `mixColors`, renderer por LOD, labels acessíveis e slots de interface |
| Estilo | CSS opcional, `style`, `className`, `classNames` por parte e tokens CSS |

Os tipos `SpatialLayoutOptions`, `SpatialSceneOptions` e os defaults são exportados pela engine. A opção matemática `SpatialCameraOptions` da engine contém `responseMs`; a opção de câmera exportada por React a estende com configurações de gestos e foco. Configurações numéricas inválidas falham cedo.

Tokens padrão incluem `--spatial-background`, `--spatial-foreground`, `--spatial-stage-background`, `--spatial-card-background`, `--spatial-font-family`, `--spatial-region-border`, `--spatial-toolbar-background`, `--spatial-selection-ring` e `--spatial-focus-ring`. Classes/estilos do consumidor podem alterar fontes, sombras, contornos e conteúdo sem mudar índice/layout. O stylesheet padrão não importa reset global da demo.

Manter referências estáveis para arrays de entrada, opções com callbacks e adaptadores quando possível. Mudança de dados reconstrói snapshots; pan preserva geometria local e reaproveita os componentes existentes. Os parâmetros da cena são normalizados por valor para o preparo da engine, inclusive quando o consumidor fornece um objeto equivalente novo.

## Limites atuais

Estes pacotes têm fronteiras e declarações para reutilização no workspace; publicação, versionamento público e compatibilidade formal de uma distribuição externa ainda não foram definidos. A engine calcula uma hierarquia canônica, não o grafo de dependências de um produto. Persistência, políticas de acesso, pesquisa e relações de negócio pertencem ao consumidor.
