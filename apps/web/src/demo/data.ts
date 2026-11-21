import type { TreeNode } from "@treepm/engine";
import type { TFunction } from "i18next";

export interface DemoNode extends TreeNode {
  readonly label: string;
  readonly color: string;
  readonly sampleValue: number;
}

const REGIONS = [
  { key: "aurora", color: "#8459b8" },
  { key: "coral", color: "#b94361" },
  { key: "forest", color: "#21865e" },
  { key: "ocean", color: "#286fad" },
  { key: "amber", color: "#aa641c" },
  { key: "iris", color: "#6154b5" },
] as const;

/** Fixed input order and topology: 1 root, 6 regions, 994 descendants. */
/** Os nomes vêm do catálogo `demo` no idioma de `t`; a topologia é a mesma em todos. */
export function createDemoItems(t: TFunction<"demo">): readonly DemoNode[] {
  const items: DemoNode[] = [{ id: "node-0000", parentId: null, label: t("data.root"), color: "#6853a5", sampleValue: 0 }];
  let sequence = 1;
  for (const [regionIndex, region] of REGIONS.entries()) {
    const add = (parentId: string, label: string) => {
      const id = `node-${String(sequence++).padStart(4, "0")}`;
      items.push({ id, parentId, label, color: region.color, sampleValue: sequence - 1 });
      return id;
    };
    const name = t(`data.regions.${region.key}`);
    const regionId = add("node-0000", name);
    const budget = regionIndex < 4 ? 166 : 165;
    let created = 0;
    // A narrow branch reaches depth 7; broad siblings exercise merged indicator buckets.
    let parentId = regionId;
    for (let level = 2; level <= 7; level++) {
      parentId = add(parentId, t("data.layer", { region: name, level }));
      created++;
    }
    const families = Array.from({ length: 12 }, (_, index) => add(regionId, t("data.sector", { region: name, index: index + 1 })));
    created += families.length;
    const candidates = families.map((id) => ({ id, depth: 2 }));
    let cursor = 0;
    while (created < budget) {
      const parent = candidates[cursor++];
      if (!parent) throw new Error("Demo topology exhausted");
      const childCount = regionIndex < 2 ? 16 : 3;
      for (let child = 0; child < childCount && created < budget; child++) {
        const id = add(parent.id, t("data.element", { region: name, index: created + 1 }));
        created++;
        if (parent.depth < 6) candidates.push({ id, depth: parent.depth + 1 });
      }
    }
  }
  return items;
}
