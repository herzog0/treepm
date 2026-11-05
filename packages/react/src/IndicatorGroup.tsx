import { memo, useMemo } from "react";
import type { CSSProperties } from "react";
import { equalSemanticProps, groupGeometryStyle, useGeometrySeed } from "./useGeometryStyle.js";
import type { GroupGeometry } from "./useGeometryStyle.js";
import type { GeometryRegistry } from "./useSceneGeometry.js";
import type { TreeIndex, TreeNode } from "@treepm/engine";
import type { MixColors, NodeAppearance } from "./appearance.js";
import { mixIndicatorColors } from "./colors.js";

interface IndicatorGroupProps<TNode extends TreeNode> {
  id: string;
  parentId: string;
  childIds: readonly string[];
  initialGeometry: GroupGeometry;
  registry: GeometryRegistry;
  index: TreeIndex<TNode>;
  appearances: ReadonlyMap<string, NodeAppearance>;
  mixColors?: MixColors<TNode>;
  className?: string;
  getGroupAriaLabel?: (members: readonly TNode[]) => string;
}
function IndicatorGroupView<TNode extends TreeNode>(props: IndicatorGroupProps<TNode>) {
  const { childIds, index, appearances, mixColors, getGroupAriaLabel } = props;
  const appearance = useMemo(() => {
    const members = childIds.map((id) => {
      const member = index.itemById.get(id);
      if (!member) throw new Error(`Missing indicator member: ${id}`);
      return member;
    });
    const colors = members.map((member) => ({ color: appearances.get(member.id)?.color ?? "#6853a5", weight: 1 }));
    const color = mixColors ? mixColors(colors, members) : mixIndicatorColors(colors);
    const label = getGroupAriaLabel?.(members) ?? `${members.length} nodes: ${members.map((member) => `${member.id} · ${appearances.get(member.id)?.label ?? member.id}`).join(", ")}`;
    return { color, label };
  }, [childIds, index, appearances, mixColors, getGroupAriaLabel]);
  const { ref, initialStyle } = useGeometrySeed(groupGeometryStyle(props.initialGeometry), props.registry.groupRef, props.id);
  const style: CSSProperties & { "--spatial-color": string } = useMemo(() => ({ ...initialStyle, "--spatial-color": appearance.color }), [initialStyle, appearance.color]);
  return useMemo(() => <span ref={ref} className={`spatial-indicator-group spatial-indicator-group-surface ${props.className ?? ""}`} role="img"
    data-spatial-group-id={props.id} aria-label={appearance.label} title={appearance.label}
    style={style} />, [ref, props.className, props.id, appearance.label, style]);
}
export const IndicatorGroup = memo(IndicatorGroupView, equalSemanticProps) as typeof IndicatorGroupView;
