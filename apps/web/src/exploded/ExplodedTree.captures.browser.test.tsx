import { afterEach, describe, it } from "vitest";
import "@fontsource-variable/inter";
import "../theme.css";
import "../styles.css";
import "../controls.css";
import "../assistant/assistant.css";
import "../map/map.css";
import "../map/agent-work.css";
import "@treepm/react/styles.css";
import { dependencyProject, dependencyTickets } from "../test/dependencyMap.js";
import { captureTree } from "../test/treeCaptures.js";

// Capturas da árvore explodida com a fixture de 33 tickets: só rodam com `VITE_TREEPM_CAPTURES=1`; os PNGs saem em `screenshots/arvore/`
// na raiz do worktree (fora do Git). O app só tem o tema escuro.
const ON = (import.meta.env as Record<string, string | undefined>)["VITE_TREEPM_CAPTURES"] === "1";

describe.skipIf(!ON)("capturas da árvore explodida", () => {
  afterEach(() => {
    document.body.replaceChildren();
    window.localStorage.clear();
    window.history.replaceState(null, "", "/");
  });

  it("a fixture de 33 tickets: primeira vista, de perto, inteira e um ticket selecionado", async () => {
    await captureTree(dependencyProject, dependencyTickets(), "../../../../screenshots/arvore");
  });
});
