import type { ReactNode } from "react";
import type { SpatialLod, TreeNode } from "@treepm/engine";
import type { IndicatorColor } from "./colors.js";

export interface SpatialNodeContent<TNode extends TreeNode> {
  readonly node: TNode;
  readonly label: string;
  readonly lod: SpatialLod;
  readonly aggregate: boolean;
  readonly depth: number;
  readonly childCount: number;
  readonly descendantCount: number;
}
export type RenderNodeContent<TNode extends TreeNode> = (context: SpatialNodeContent<TNode>) => ReactNode;
export type MixColors<TNode extends TreeNode> = (colors: readonly IndicatorColor[], members: readonly TNode[]) => string;
export interface SpatialAppearance<TNode extends TreeNode> {
  readonly getLabel?: (node: TNode) => string;
  readonly getColor?: (node: TNode) => string;
  readonly mixColors?: MixColors<TNode>;
}
export interface NodeAppearance {
  readonly label: string;
  readonly color: string;
}
export const defaultGetLabel = (node: TreeNode): string => node.id;
export const defaultGetColor = (): string => "#6853a5";
