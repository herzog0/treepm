import { SpatialCanvas } from "./canvas/SpatialCanvas.js";
import { demoItems } from "./demo/data.js";

export function App() {
  return <SpatialCanvas items={demoItems} />;
}
