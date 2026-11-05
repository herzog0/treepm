import type { SpatialItem } from "@treepm/engine";

const REGIONS = [
  { label: "Aurora", color: "#8459b8" },
  { label: "Coral", color: "#b94361" },
  { label: "Bosque", color: "#21865e" },
  { label: "Oceano", color: "#286fad" },
  { label: "Âmbar", color: "#aa641c" },
  { label: "Íris", color: "#6154b5" },
] as const;

/** Fixed input order and topology: 1 root, 6 regions, 994 descendants. */
function createDemoItems(): readonly SpatialItem[] {
  const items: SpatialItem[] = [{ id: "node-0000", parentId: null, label: "Constelação", color: "#6853a5" }];
  let sequence = 1;
  for (const [regionIndex, region] of REGIONS.entries()) {
    const add = (parentId: string, label: string) => {
      const id = `node-${String(sequence++).padStart(4, "0")}`;
      items.push({ id, parentId, label, color: region.color });
      return id;
    };
    const regionId = add("node-0000", region.label);
    const budget = regionIndex < 4 ? 166 : 165;
    let created = 0;
    // A narrow branch reaches depth 7; broad siblings exercise indicator +N.
    let parentId = regionId;
    for (let level = 2; level <= 7; level++) {
      parentId = add(parentId, `${region.label} · camada ${level}`);
      created++;
    }
    const families = Array.from({ length: 12 }, (_, index) => add(regionId, `${region.label} · setor ${index + 1}`));
    created += families.length;
    const candidates = families.map((id) => ({ id, depth: 2 }));
    let cursor = 0;
    while (created < budget) {
      const parent = candidates[cursor++];
      if (!parent) throw new Error("Demo topology exhausted");
      const childCount = regionIndex < 2 ? 16 : 3;
      for (let child = 0; child < childCount && created < budget; child++) {
        const id = add(parent.id, `${region.label} · elemento ${created + 1}`);
        created++;
        if (parent.depth < 6) candidates.push({ id, depth: parent.depth + 1 });
      }
    }
  }
  return items;
}

export const demoItems = createDemoItems();
