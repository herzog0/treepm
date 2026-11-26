// Etiquetas por projeto (ADR 0065): rotas do cliente, erros com frase própria e as etiquetas no resumo do ticket.
import { describe, expect, it, vi } from "vitest";
import i18n from "../i18n/index.js";
import { createApiClient } from "./client.js";
import { describeApiError } from "./errorText.js";

const P = "11111111-1111-4111-8111-111111111111";
const L = "22222222-2222-4222-8222-222222222222";
const T = "33333333-3333-4333-8333-333333333333";

function setup(body: unknown = {}, status = 200) {
  const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => Response.json(body, { status }));
  const client = createApiClient({ getToken: async () => "tok", fetch: fetchImpl });
  return { client, fetchImpl };
}
const lastCall = (fetchImpl: ReturnType<typeof setup>["fetchImpl"]) => {
  const [path, init] = fetchImpl.mock.calls.at(-1)!;
  return { path, method: init?.method ?? "GET", body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) };
};
const bug = { id: L, name: "Bug", color: "rose", ticketCount: 3 };

describe("rotas de etiquetas (ADR 0065)", () => {
  it("lista as etiquetas do projeto", async () => {
    const { client, fetchImpl } = setup([bug]);
    expect(await client.listProjectLabels(P)).toEqual({ ok: true, data: [bug] });
    expect(lastCall(fetchImpl)).toMatchObject({ path: `/api/projects/${P}/labels`, method: "GET" });
  });

  it("cria, renomeia e apaga", async () => {
    const created = setup({ ...bug, ticketCount: 0 }, 201);
    expect(await created.client.createProjectLabel(P, { name: "Bug" })).toEqual({ ok: true, data: { ...bug, ticketCount: 0 } });
    expect(lastCall(created.fetchImpl)).toEqual({ path: `/api/projects/${P}/labels`, method: "POST", body: { name: "Bug" } });

    const renamed = setup({ ...bug, name: "Defeito", color: "cyan" });
    expect(await renamed.client.updateProjectLabel(P, L, { name: "Defeito", color: "cyan" })).toMatchObject({ ok: true, data: { name: "Defeito", color: "cyan" } });
    expect(lastCall(renamed.fetchImpl)).toEqual({ path: `/api/projects/${P}/labels/${L}`, method: "PATCH", body: { name: "Defeito", color: "cyan" } });

    const removed = setup({ ticketsAffected: 3 });
    expect(await removed.client.removeProjectLabel(P, L)).toEqual({ ok: true, data: { ticketsAffected: 3 } });
    expect(lastCall(removed.fetchImpl)).toMatchObject({ path: `/api/projects/${P}/labels/${L}`, method: "DELETE" });
  });

  it("põe e tira etiquetas do ticket e devolve as etiquetas dele depois", async () => {
    const labels = [{ id: L, name: "Bug", color: "rose" }];
    const { client, fetchImpl } = setup({ labels });
    expect(await client.changeTicketLabels(T, { add: [{ labelId: L }, { name: "Novo" }], remove: [] })).toEqual({ ok: true, data: { labels } });
    expect(lastCall(fetchImpl)).toEqual({ path: `/api/tickets/${T}/labels`, method: "POST", body: { add: [{ labelId: L }, { name: "Novo" }], remove: [] } });
  });

  it("cor desconhecida vinda do servidor vira cinza, sem derrubar a leitura", async () => {
    const { client } = setup([{ ...bug, color: "chartreuse" }]);
    expect(await client.listProjectLabels(P)).toMatchObject({ ok: true, data: [{ color: "gray" }] });
  });

  it("o resumo do ticket traz as etiquetas", async () => {
    const summary = { id: T, projectId: P, number: 1, key: "ENG-1", parentId: null, title: "A", status: "todo", progress: null, assigneeIds: [], descriptionExcerpt: "", labels: [{ id: L, name: "Bug", color: "rose" }] };
    const { client } = setup([summary]);
    const result = await client.listTickets(P);
    expect(result.ok && result.data[0]?.labels).toEqual([{ id: L, name: "Bug", color: "rose" }]);
  });

  it.each(["label_limit_ticket", "label_limit_project", "label_name_taken", "label_name_invalid", "label_not_found"])("%s tem frase própria nos três idiomas", async (code) => {
    for (const language of ["pt-BR", "en", "es-MX"]) {
      const t = i18n.getFixedT(language);
      const text = describeApiError(t, { kind: "conflict", code });
      expect(text).not.toBe(describeApiError(t, { kind: "conflict" }));
    }
  });
});
