import type { TreeNode } from "@treepm/engine";
import type { Me, Project } from "../api/client.js";

export interface MapNode extends TreeNode {
  readonly kind: "organization" | "project";
  readonly label: string;
  readonly color: string;
  /** Chave do projeto, mostrada onde a demo mostra o ID. */
  readonly key: string | null;
}

export const ORGANIZATION_COLOR = "#6853a5";

const PALETTE = [
  "#8459b8",
  "#b94361",
  "#21865e",
  "#286fad",
  "#aa641c",
  "#6154b5",
  "#a8397f",
  "#1f7f8a",
] as const;

/** Cor estável por semente (ID ou chave do projeto): hash FNV-1a sobre a paleta. */
export function projectColor(seed: string): string {
  let hash = 0x811c9dc5;
  for (let position = 0; position < seed.length; position++) {
    hash ^= seed.charCodeAt(position);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return PALETTE[hash % PALETTE.length]!;
}

export function buildMapItems(organization: Me["organization"], projects: readonly Project[]): readonly MapNode[] {
  const root: MapNode = {
    id: organization.orgId,
    parentId: null,
    kind: "organization",
    label: organization.name,
    color: ORGANIZATION_COLOR,
    key: null,
  };
  const children = projects
    .filter((project) => project.archivedAt === null)
    .map<MapNode>((project) => ({
      id: project.id,
      parentId: organization.orgId,
      kind: "project",
      label: project.name,
      color: projectColor(project.id),
      key: project.key,
    }));
  return [root, ...children];
}
