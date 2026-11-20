import type { MapNode } from "../map/items.js";

/** Como o mapa devolve ao painel o clique em um nó enquanto a pessoa "escolhe no mapa". */
export interface MapPicker {
  pick: (node: MapNode) => void;
  cancel: () => void;
}
