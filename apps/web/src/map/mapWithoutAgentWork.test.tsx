import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Project, TicketSummary } from "../api/client.js";
import { makeTicket } from "../test/fakes.js";
import { buildMapItems } from "./items.js";
import { renderNodeContent } from "./nodeContent.js";

/**
 * ADR 0043, fatia 3: o mapa não muda em nada além do contorno do marcador de trabalho pela IA. Este teste guarda o HTML
 * exato (classes e atributos) que cada card desenha, em todos os níveis de detalhe, para uma árvore SEM marcador, e não
 * pode ser editado por causa do marcador.
 */
const org = { orgId: "org_1", name: "Equipe Alfa", slug: "alfa" };
const project: Project = { id: "p", name: "Alfa", key: "ALFA", visibility: "organization", archivedAt: null, members: [], teamIds: [] };

const tickets: TicketSummary[] = [
  makeTicket("t1", "p", 1, "Raiz com tudo", { status: "in_progress", progress: { done: 2, total: 6, excluded: 1 } }),
  makeTicket("t2", "p", 2, "Filho em andamento", { parentId: "t1", status: "in_progress" }),
  makeTicket("t3", "p", 3, "Filho concluído", { parentId: "t1", status: "done" }),
  makeTicket("t4", "p", 4, "Neto a fazer", { parentId: "t2", status: "todo" }),
];

describe("map without an agent-work marker", () => {
  it("draws every card exactly as before at every level of detail", () => {
    const items = buildMapItems(org, [project], { p: tickets });
    const html = Object.fromEntries(
      items.map((node) => [
        node.id,
        Object.fromEntries(
          (["dot", "chip", "compact", "full"] as const).map((lod) => {
            const { container, unmount } = render(<>{renderNodeContent({ node, label: node.label, lod, aggregate: false, depth: 1, childCount: 2, descendantCount: 3 })}</>);
            const markup = container.innerHTML;
            unmount();
            return [lod, markup];
          }),
        ),
      ]),
    );
    expect(html).toMatchInlineSnapshot(`
      {
        "org_1": {
          "chip": "<strong>Equipe Alfa</strong>",
          "compact": "<span class="spatial-key">Organização</span><strong>Equipe Alfa</strong>",
          "dot": "",
          "full": "<span class="spatial-key">Organização</span><strong>Equipe Alfa</strong><span class="spatial-card-meta">2 projetos</span>",
        },
        "p": {
          "chip": "<strong>Alfa</strong>",
          "compact": "<span class="spatial-key">ALFA</span><strong>Alfa</strong>",
          "dot": "",
          "full": "<span class="spatial-key">ALFA</span><strong>Alfa</strong>",
        },
        "t1": {
          "chip": "<span class="status-mark" aria-hidden="true" data-state="progress" data-fill="0.3333333333333333" style="--fill: 0.3333333333333333;"></span><strong>Raiz com tudo</strong><span class="node-counts" title="6 tickets · 2 prontos · 1 livre">6 · 2 · 1</span>",
          "compact": "<span class="node-key-row"><span class="spatial-key">P-1</span><span class="node-counts" title="6 tickets · 2 prontos · 1 livre">6 · 2 · 1</span></span><strong>Raiz com tudo</strong><span class="node-state"><span class="status-mark" aria-hidden="true" data-state="progress" data-fill="0.3333333333333333" style="--fill: 0.3333333333333333;"></span></span>",
          "dot": "<span class="node-dot-hint" title="6 tickets · 2 prontos · 1 livre"></span>",
          "full": "<span class="spatial-key">P-1</span><strong>Raiz com tudo</strong><span class="node-state"><span class="status-mark" aria-hidden="true" data-state="progress" data-fill="0.3333333333333333" style="--fill: 0.3333333333333333;"></span><span class="node-counts-long">6 tickets · 2 prontos · 1 livre</span></span>",
        },
        "t2": {
          "chip": "<span class="status-mark" aria-hidden="true" data-state="in_progress" data-fill="0.5" style="--fill: 0.5;"></span><strong>Filho em andamento</strong>",
          "compact": "<span class="spatial-key">P-2</span><strong>Filho em andamento</strong><span class="node-state"><span class="status-mark" aria-hidden="true" data-state="in_progress" data-fill="0.5" style="--fill: 0.5;"></span></span>",
          "dot": "",
          "full": "<span class="spatial-key">P-2</span><strong>Filho em andamento</strong><span class="node-state"><span class="status-mark" aria-hidden="true" data-state="in_progress" data-fill="0.5" style="--fill: 0.5;"></span><span>Em andamento</span></span>",
        },
        "t3": {
          "chip": "<span class="status-mark" aria-hidden="true" data-state="done" data-fill="1" style="--fill: 1;"></span><strong>Filho concluído</strong>",
          "compact": "<span class="spatial-key">P-3</span><strong>Filho concluído</strong><span class="node-state"><span class="status-mark" aria-hidden="true" data-state="done" data-fill="1" style="--fill: 1;"></span></span>",
          "dot": "",
          "full": "<span class="spatial-key">P-3</span><strong>Filho concluído</strong><span class="node-state"><span class="status-mark" aria-hidden="true" data-state="done" data-fill="1" style="--fill: 1;"></span><span>Concluído</span></span>",
        },
        "t4": {
          "chip": "<span class="status-mark" aria-hidden="true" data-state="todo" data-fill="0" data-place="free" style="--fill: 0;"></span><strong>Neto a fazer</strong>",
          "compact": "<span class="spatial-key">P-4</span><strong>Neto a fazer</strong><span class="node-state"><span class="status-mark" aria-hidden="true" data-state="todo" data-fill="0" data-place="free" style="--fill: 0;"></span></span>",
          "dot": "",
          "full": "<span class="spatial-key">P-4</span><strong>Neto a fazer</strong><span class="node-state"><span class="status-mark" aria-hidden="true" data-state="todo" data-fill="0" data-place="free" style="--fill: 0;"></span><span>Livre</span></span>",
        },
      }
    `);
  });
});
