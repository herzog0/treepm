import { describe, expect, it } from "vitest";
import { TicketCommentsService } from "../src/tickets/ticket-comments.service.js";
import { TicketsService } from "../src/tickets/tickets.service.js";
import { useHarness } from "./harness.js";
import { ORG, refusalOfResponse, refusalOfService } from "./service-door.js";
import type { Refusal } from "./service-door.js";
import { OTHER_ORG, as } from "./world.js";
import type { Who } from "./world.js";

/**
 * ADR 0043, fatia 1: mudar a situação e comentar têm UM caminho de regras, usado pela rota HTTP e (na fatia 2) pelo MCP.
 * Cada caso é feito pelas duas portas (a rota HTTP e o serviço chamado direto) e as duas precisam dar a mesma resposta.
 */
const h = useHarness();
const P = () => h.world().projects.priv;
type Body = Record<string, unknown>;
const make = async (body: Body = {}): Promise<{ id: string }> => {
  const res = await h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "T", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string };
};
const UNKNOWN = "0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000";

type Door = { http: () => Promise<Refusal>; service: () => Promise<Refusal> };
const statusDoors = (ticket: string, status: string, who: Who | "outsider" = "contributor", org = ORG): Door => ({
  http: async () => refusalOfResponse(await h.call("PATCH", `/api/tickets/${ticket}`, as(who as Who, org), { status })),
  service: () => refusalOfService(h.app(), who, org, (tx, principal) => h.app().get(TicketsService).updateTicket(tx, principal, ticket, { status } as never)),
});
const commentDoors = (ticket: string, body: string, who: Who | "outsider" = "contributor", org = ORG): Door => ({
  http: async () => refusalOfResponse(await h.call("POST", `/api/tickets/${ticket}/comments`, as(who as Who, org), { body })),
  service: () => refusalOfService(h.app(), who, org, (tx, principal) => h.app().get(TicketCommentsService).add(tx, principal, ticket, body)),
});

async function both(make: () => Promise<Door>, expected: Refusal): Promise<void> {
  // Cada porta tem a sua semente: a recusa não pode depender de a outra ter rodado antes.
  const fresh = async (): Promise<Door> => {
    await h.pool.query("update projects set archived_at = null where id = $1", [P()]);
    return make();
  };
  expect(await (await fresh()).http(), "porta HTTP").toEqual(expected);
  expect(await (await fresh()).service(), "porta do serviço").toEqual(expected);
}

describe("mudar a situação: a rota HTTP e o serviço dão a mesma resposta", () => {
  it("sucesso", async () => {
    await both(async () => statusDoors((await make()).id, "in_progress"), null);
  });
  it("leitor do projeto: 403", async () => {
    await both(async () => statusDoors((await make()).id, "in_progress", "reader"), { status: 403, code: "forbidden" });
  });
  it("pessoa sem acesso ao projeto privado: 404", async () => {
    await both(async () => statusDoors((await make()).id, "in_progress", "plain"), { status: 404, code: "not_found" });
  });
  it("projeto arquivado: 409 project_archived", async () => {
    await both(async () => {
      const t = await make();
      await h.pool.query("update projects set archived_at = now() where id = $1", [P()]);
      return statusDoors(t.id, "in_progress");
    }, { status: 409, code: "project_archived" });
  });
  it("concluir com filho aberto: 409 ticket_has_open_children", async () => {
    await both(async () => {
      const parent = await make();
      await make({ parentId: parent.id });
      return statusDoors(parent.id, "done");
    }, { status: 409, code: "ticket_has_open_children" });
  });
  it("mudar a situação de ticket dentro de uma ideia: 409 ticket_in_idea", async () => {
    await both(async () => {
      const idea = await make({ idea: true });
      const inside = await make({ parentId: idea.id });
      return statusDoors(inside.id, "in_progress");
    }, { status: 409, code: "ticket_in_idea" });
  });
  it("ticket que não existe: 404", async () => {
    await both(async () => statusDoors(UNKNOWN, "in_progress"), { status: 404, code: "not_found" });
  });
  it("ticket de outra organização: 404", async () => {
    await both(async () => statusDoors((await make()).id, "in_progress", "outsider", OTHER_ORG), { status: 404, code: "not_found" });
  });
  it("reabre o pai concluído quando o filho volta a ficar aberto, pelas duas portas", async () => {
    for (const door of ["http", "service"] as const) {
      const parent = await make();
      const child = await make({ parentId: parent.id });
      expect((await h.call("PATCH", `/api/tickets/${child.id}`, as("admin"), { status: "done" })).status).toBe(200);
      expect((await h.call("PATCH", `/api/tickets/${parent.id}`, as("admin"), { status: "done" })).status).toBe(200);
      expect(await statusDoors(child.id, "in_progress")[door](), door).toBeNull();
      const row = await h.pool.query("select status from tickets where id = $1", [parent.id]);
      expect(row.rows[0].status, door).toBe("todo");
    }
  });
});

describe("comentar: a rota HTTP e o serviço dão a mesma resposta", () => {
  it("sucesso", async () => {
    await both(async () => commentDoors((await make()).id, "oi"), null);
  });
  it("pessoa sem acesso ao projeto privado: 404", async () => {
    await both(async () => commentDoors((await make()).id, "oi", "plain"), { status: 404, code: "not_found" });
  });
  it("projeto arquivado: 409 project_archived", async () => {
    await both(async () => {
      const t = await make();
      await h.pool.query("update projects set archived_at = now() where id = $1", [P()]);
      return commentDoors(t.id, "oi");
    }, { status: 409, code: "project_archived" });
  });
  it("ticket que não existe e ticket de outra organização: 404", async () => {
    await both(async () => commentDoors(UNKNOWN, "oi"), { status: 404, code: "not_found" });
    await both(async () => commentDoors((await make()).id, "oi", "outsider", OTHER_ORG), { status: 404, code: "not_found" });
  });
});
