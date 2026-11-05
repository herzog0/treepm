import { memo, useMemo } from "react";
import type { CSSProperties } from "react";
import type { SpatialIndicatorGroup, TreeIndex, TreeNode } from "@treepm/engine";
import type { MixColors, NodeAppearance } from "./appearance.js";
import { mixIndicatorColors } from "./colors.js";

interface IndicatorGroupProps<TNode extends TreeNode> extends SpatialIndicatorGroup {
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
  const width = props.width * props.scale;
  const height = props.height * props.scale;
  return <span className={`spatial-indicator-group ${props.className ?? ""}`} role="img"
    data-spatial-group-id={props.id} aria-label={appearance.label} title={appearance.label}
    style={{ "--spatial-color": appearance.color, width, height, opacity: props.opacity, transform: `translate3d(${props.x - width / 2}px, ${props.y}px, 0)` } as CSSProperties}>
    <span className="spatial-indicator-group-surface" aria-hidden="true"
      style={{ width: props.width, height: props.height, transform: `scale(${props.scale})` }} />
  </span>;
}
export const IndicatorGroup = memo(IndicatorGroupView) as typeof IndicatorGroupView;
