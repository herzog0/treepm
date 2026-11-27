import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { Project, TicketSummary } from "../api/client.js";
import { makeTicket } from "../test/fakes.js";
import { buildMapItems } from "./items.js";
import { renderNodeContent } from "./nodeContent.js";

/**
 * ADR 0042, fatia 2: o mapa não muda em nada além da cor dos nós de ideia. Este teste guarda o que o mapa desenha
 * para uma árvore SEM ideias (cor de cada nó e, em cada nível de detalhe, o texto e o marcador de cada card) e
 * não pode ser editado por causa da ideia.
 */
const org = { orgId: "org_1", name: "Equipe Alfa", slug: "alfa" };
const project: Project = { id: "p", name: "Alfa", key: "ALFA", visibility: "organization", archivedAt: null, members: [], teamIds: [] };

const tickets: TicketSummary[] = [
  makeTicket("t1", "p", 1, "Raiz com tudo", { status: "in_progress", progress: { done: 2, total: 6, excluded: 1 } }),
  makeTicket("t2", "p", 2, "Filho em andamento", { parentId: "t1", status: "in_progress" }),
  makeTicket("t3", "p", 3, "Filho concluído", { parentId: "t1", status: "done" }),
  makeTicket("t4", "p", 4, "Neto em revisão", { parentId: "t2", status: "in_review" }),
  makeTicket("t5", "p", 5, "Neto a fazer", { parentId: "t2", status: "todo" }),
  makeTicket("t6", "p", 6, "Neto cancelado", { parentId: "t2", status: "cancelled" }),
  makeTicket("t7", "p", 7, "Concluído com filhos prontos", { status: "done", progress: { done: 2, total: 2, excluded: 0 } }),
  makeTicket("t8", "p", 8, "Filho pronto", { parentId: "t7", status: "done" }),
  makeTicket("t9", "p", 9, "Outro pronto", { parentId: "t7", status: "done" }),
  makeTicket("t10", "p", 10, "Folha cancelada", { status: "cancelled" }),
  makeTicket("t11", "p", 11, "Folha a fazer", { status: "todo" }),
];

const lods = ["chip", "compact", "full"] as const;

function describeMap() {
  const items = buildMapItems(org, [project], { p: tickets });
  const colors = Object.fromEntries(items.map((node) => [node.id, `${node.color}/${node.leafCount}`]));
  const cards = items.map((node) =>
    Object.fromEntries(
      lods.map((lod) => {
        const { container } = render(<>{renderNodeContent({ node, label: node.label, lod, aggregate: false, depth: 1, childCount: 2, descendantCount: 3 })}</>);
        const marks = [...container.querySelectorAll("[data-state]")].map((mark) => `${mark.getAttribute("data-state")}:${mark.getAttribute("data-fill")}`);
        return [lod, `${container.textContent ?? ""} | ${marks.join(",")}`];
      }),
    ),
  );
  return { colors, cards };
}

describe("map without ideas", () => {
  it("keeps the color and the card text of every node at every level of detail", () => {
    expect(describeMap()).toMatchInlineSnapshot(`
      {
        "cards": [
          {
            "chip": "Equipe Alfa | ",
            "compact": "OrganizaçãoEquipe Alfa | ",
            "full": "OrganizaçãoEquipe Alfa2 projetos | ",
          },
          {
            "chip": "Alfa | ",
            "compact": "ALFAAlfa | ",
            "full": "ALFAAlfa | ",
          },
          {
            "chip": "Raiz com tudo6 · 2 · 1 | progress:0.3333333333333333",
            "compact": "P-16 · 2 · 1Raiz com tudo | progress:0.3333333333333333",
            "full": "P-1Raiz com tudo6 tickets · 2 prontos · 1 livre | progress:0.3333333333333333",
          },
          {
            "chip": "Filho em andamento | in_progress:0.5",
            "compact": "P-2Filho em andamento | in_progress:0.5",
            "full": "P-2Filho em andamentoEm andamento | in_progress:0.5",
          },
          {
            "chip": "Filho concluído | done:1",
            "compact": "P-3Filho concluído | done:1",
            "full": "P-3Filho concluídoConcluído | done:1",
          },
          {
            "chip": "Neto em revisão | in_review:0.75",
            "compact": "P-4Neto em revisão | in_review:0.75",
            "full": "P-4Neto em revisãoEm revisão | in_review:0.75",
          },
          {
            "chip": "Neto a fazer | todo:0",
            "compact": "P-5Neto a fazer | todo:0",
            "full": "P-5Neto a fazerLivre | todo:0",
          },
          {
            "chip": "Neto cancelado | cancelled:0",
            "compact": "P-6Neto cancelado | cancelled:0",
            "full": "P-6Neto canceladoCancelado | cancelled:0",
          },
          {
            "chip": "Concluído com filhos prontos2 · 2 · 0 | done:1",
            "compact": "P-72 · 2 · 0Concluído com filhos prontos | done:1",
            "full": "P-7Concluído com filhos prontosConcluído · 2 tickets · 2 prontos · 0 livres | done:1",
          },
          {
            "chip": "Filho pronto | done:1",
            "compact": "P-8Filho pronto | done:1",
            "full": "P-8Filho prontoConcluído | done:1",
          },
          {
            "chip": "Outro pronto | done:1",
            "compact": "P-9Outro pronto | done:1",
            "full": "P-9Outro prontoConcluído | done:1",
          },
          {
            "chip": "Folha cancelada | cancelled:0",
            "compact": "P-10Folha cancelada | cancelled:0",
            "full": "P-10Folha canceladaCancelado | cancelled:0",
          },
          {
            "chip": "Folha a fazer | todo:0",
            "compact": "P-11Folha a fazer | todo:0",
            "full": "P-11Folha a fazerLivre | todo:0",
          },
        ],
        "colors": {
          "org_1": "#ffd000/1",
          "p": "#ffd000/1",
          "t1": "#ffd000/5",
          "t10": "#3c404c/1",
          "t11": "#ffb07a/1",
          "t2": "#ffd000/1",
          "t3": "#2ee6b6/1",
          "t4": "#ffd000/1",
          "t5": "#ffb07a/1",
          "t6": "#3c404c/1",
          "t7": "#2ee6b6/1",
          "t8": "#2ee6b6/1",
          "t9": "#2ee6b6/1",
        },
      }
    `);
  });
});
