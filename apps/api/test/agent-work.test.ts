import { describe, expect, it } from "vitest";
import { AgentWorkService } from "../src/tickets/agent-work.service.js";
import { MINUTE, useTokenHarness } from "./access-token-support.js";
import { asService, refusalOf, refusalOfResponse } from "./service-door.js";
import { OTHER_ORG, as } from "./world.js";
import type { Who } from "./world.js";

// ADR 0043, fatia 1: o marcador de trabalho pela IA no ticket (banco, leitura, encerrar pela tela, eventos).
const h = useTokenHarness();
const P = () => h.world().projects.priv;
type Body = Record<string, unknown>;
type Marker = { since: string; until: string; note: string; by?: { id: string; displayName: string } };
const make = async (body: Body = {}): Promise<{ id: string; key: string }> => {
  const res = await h.call("POST", `/api/projects/${P()}/tickets`, as("admin"), { title: "T", ...body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body as { id: string; key: string };
};
const mark = (who: Who, id: string, input: { working: boolean; minutes?: number; note?: string }) =>
  asService(h.app(), who, "org_A", (tx, principal) => h.app().get(AgentWorkService).set(tx, principal, id, input));
const detail = async (id: string, who: Who = "admin") => (await h.call("GET", `/api/tickets/${id}`, as(who))).body;
const events = async (kind: string) => (await h.pool.query("select * from activity_events where kind = $1 order by occurred_at, id", [kind])).rows;
const feed = async (id: string) => (await h.call("GET", `/api/tickets/${id}/activity`, as("admin"))).body.entries as { type: string; [k: string]: unknown }[];

describe("ligar o marcador (serviço)", () => {
  it("liga por 60 minutos por padrão e aparece no resumo (sem quem ligou) e no detalhe (com quem ligou)", async () => {
    const t = await make();
    const state = (await mark("contributor", t.id, { working: true, note: "escrevendo os testes" })) as Marker;
    expect(state.note).toBe("escrevendo os testes");
    expect(Date.parse(state.until) - Date.parse(state.since)).toBe(60 * MINUTE);
    const list = (await h.call("GET", `/api/projects/${P()}/tickets`, as("admin"))).body as { id: string; agentWork: Marker | null }[];
    expect(list.find((x) => x.id === t.id)?.agentWork).toEqual({ since: state.since, until: state.until, note: "escrevendo os testes" });
    const page = await detail(t.id);
    expect(page.agentWork).toMatchObject({ since: state.since, until: state.until, note: "escrevendo os testes", by: { id: h.world().people.contributor, displayName: "Nome contributor" } });
    expect(page.canEndAgentWork).toBe(true);
    expect((await detail(t.id, "reader")).canEndAgentWork).toBe(false);
  });

  it("ticket sem marcador: agentWork é null e não há botão", async () => {
    const t = await make();
    const page = await detail(t.id);
    expect(page.agentWork).toBeNull();
    expect(page.canEndAgentWork).toBe(false);
  });

  it("renova sem novo evento e pode trocar a nota; o prazo recomeça de agora", async () => {
    const t = await make();
    await mark("contributor", t.id, { working: true, minutes: 30, note: "um" });
    h.clock.advance(10 * MINUTE);
    const again = (await mark("contributor", t.id, { working: true, minutes: 30, note: "dois" })) as Marker;
    expect(again.note).toBe("dois");
    expect(Date.parse(again.until)).toBe(h.clock.now() + 30 * MINUTE);
    expect(await events("ticket.agent_work_started")).toHaveLength(1);
    expect(await events("ticket.agent_work_ended")).toHaveLength(0);
    expect((await h.pool.query("select count(*)::int n from activity_events where kind like 'ticket.agent_work%'")).rows[0].n).toBe(1);
  });

  it("outra pessoa ligando num ticket já marcado NÃO renova: encerra o marcador anterior (motivo agent) e inicia um novo, com início novo", async () => {
    const t = await make();
    const first = (await mark("contributor", t.id, { working: true, minutes: 60, note: "da primeira" })) as Marker;
    h.clock.advance(10 * MINUTE);
    const second = (await mark("manager", t.id, { working: true, minutes: 30, note: "da segunda" })) as Marker;
    expect(Date.parse(second.since)).toBe(h.clock.now());
    expect(second.since).not.toBe(first.since);
    expect(second.note).toBe("da segunda");
    expect(((await detail(t.id)).agentWork as Marker).by?.id).toBe(h.world().people.manager);
    const ended = await events("ticket.agent_work_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0].payload).toMatchObject({ key: t.key, reason: "agent" });
    expect(ended[0].actor_person_id).toBe(h.world().people.manager);
    const started = await events("ticket.agent_work_started");
    expect(started.map((e) => e.actor_person_id)).toEqual([h.world().people.contributor, h.world().people.manager]);
    // a mesma pessoa, agora, renova sem evento e mantém o início
    h.clock.advance(5 * MINUTE);
    const again = (await mark("manager", t.id, { working: true, minutes: 30 })) as Marker;
    expect(again.since).toBe(second.since);
    expect(await events("ticket.agent_work_started")).toHaveLength(2);
    expect(await events("ticket.agent_work_ended")).toHaveLength(1);
  });

  it("marcador de outra pessoa que já venceu: só inicia o novo (o vencimento sozinho não gera evento de fim)", async () => {
    const t = await make();
    await mark("contributor", t.id, { working: true, minutes: 5 });
    h.clock.advance(6 * MINUTE);
    await mark("manager", t.id, { working: true });
    expect(await events("ticket.agent_work_ended")).toHaveLength(0);
    expect(await events("ticket.agent_work_started")).toHaveLength(2);
  });

  it("grava ticket.agent_work_started com a validade e SEM a nota", async () => {
    const t = await make();
    const state = (await mark("contributor", t.id, { working: true, note: "segredo da nota" })) as Marker;
    const [event] = await events("ticket.agent_work_started");
    expect(event.payload).toMatchObject({ key: t.key, until: state.until });
    expect(JSON.stringify(event.payload)).not.toContain("segredo da nota");
  });

  it.each([[4], [241], [0], [5.5]])("recusa %s minutos", async (minutes) => {
    const t = await make();
    const error = await mark("contributor", t.id, { working: true, minutes }).catch((e: unknown) => refusalOf(e));
    expect(error).toMatchObject({ status: 400 });
  });

  it("recusa nota com mais de 200 caracteres", async () => {
    const t = await make();
    expect(await mark("contributor", t.id, { working: true, note: "a".repeat(201) }).catch((e: unknown) => refusalOf(e))).toMatchObject({ status: 400 });
  });

  it("recusa ticket concluído, cancelado, ideia e ticket dentro de ideia", async () => {
    const done = await make();
    await h.call("PATCH", `/api/tickets/${done.id}`, as("admin"), { status: "done" });
    const cancelled = await make();
    await h.call("PATCH", `/api/tickets/${cancelled.id}`, as("admin"), { status: "cancelled" });
    const idea = await make({ idea: true });
    const inside = await make({ parentId: idea.id });
    for (const id of [done.id, cancelled.id, idea.id, inside.id]) {
      expect(await mark("contributor", id, { working: true }).catch((e: unknown) => refusalOf(e)), id).toMatchObject({ status: 409 });
    }
  });

  it("recusa leitor (403), pessoa sem acesso (404), outra organização (404) e projeto arquivado (409)", async () => {
    const t = await make();
    expect(await mark("reader", t.id, { working: true }).catch((e: unknown) => refusalOf(e))).toMatchObject({ status: 403 });
    expect(await mark("plain", t.id, { working: true }).catch((e: unknown) => refusalOf(e))).toMatchObject({ status: 404 });
    expect(await asService(h.app(), "outsider", OTHER_ORG, (tx, p) => h.app().get(AgentWorkService).set(tx, p, t.id, { working: true })).catch((e: unknown) => refusalOf(e))).toMatchObject({ status: 404 });
    await h.pool.query("update projects set archived_at = now() where id = $1", [P()]);
    expect(await mark("contributor", t.id, { working: true }).catch((e: unknown) => refusalOf(e))).toMatchObject({ status: 409, code: "project_archived" });
  });

  it("desliga com working=false e grava agent_work_ended (motivo agent); desligar de novo é inócuo", async () => {
    const t = await make();
    await mark("contributor", t.id, { working: true });
    expect(await mark("contributor", t.id, { working: false })).toBeNull();
    expect(await mark("contributor", t.id, { working: false })).toBeNull();
    const ended = await events("ticket.agent_work_ended");
    expect(ended).toHaveLength(1);
    expect(ended[0].payload).toMatchObject({ key: t.key, reason: "agent" });
    expect((await detail(t.id)).agentWork).toBeNull();
  });
});

describe("vencimento", () => {
  it("passado o prazo o marcador deixa de valer sozinho, sem evento e sem ninguém limpar", async () => {
    const t = await make();
    await mark("contributor", t.id, { working: true, minutes: 5 });
    h.clock.advance(5 * MINUTE + 1);
    expect((await detail(t.id)).agentWork).toBeNull();
    const list = (await h.call("GET", `/api/projects/${P()}/tickets`, as("admin"))).body as { id: string; agentWork: unknown }[];
    expect(list.find((x) => x.id === t.id)?.agentWork).toBeNull();
    expect(await events("ticket.agent_work_ended")).toHaveLength(0);
    expect((await h.pool.query("select agent_work_until from tickets where id = $1", [t.id])).rows[0].agent_work_until).not.toBeNull();
  });

  it("ligar depois de vencido conta como ligar de novo (novo evento de início)", async () => {
    const t = await make();
    await mark("contributor", t.id, { working: true, minutes: 5 });
    h.clock.advance(6 * MINUTE);
    await mark("contributor", t.id, { working: true });
    expect(await events("ticket.agent_work_started")).toHaveLength(2);
  });

  it("concluir com o marcador já vencido limpa as colunas sem evento", async () => {
    const t = await make();
    await mark("contributor", t.id, { working: true, minutes: 5 });
    h.clock.advance(6 * MINUTE);
    expect((await h.call("PATCH", `/api/tickets/${t.id}`, as("admin"), { status: "done" })).status).toBe(200);
    expect((await h.pool.query("select agent_work_until from tickets where id = $1", [t.id])).rows[0].agent_work_until).toBeNull();
    expect(await events("ticket.agent_work_ended")).toHaveLength(0);
  });
});

describe("encerrar pela tela: DELETE tickets/:id/agent-work", () => {
  it.each([["admin", 200], ["manager", 200], ["contributor", 200], ["reader", 403], ["plain", 404]] as const)("%s → %s", async (who, status) => {
    const t = await make();
    await mark("contributor", t.id, { working: true });
    const res = await h.call("DELETE", `/api/tickets/${t.id}/agent-work`, as(who));
    expect(res.status, JSON.stringify(res.body)).toBe(status);
    if (status === 200) {
      expect(res.body.agentWork).toBeNull();
      expect((await events("ticket.agent_work_ended"))[0].payload).toMatchObject({ reason: "person" });
    }
  });

  it("é idempotente: sem marcador devolve o detalhe e não grava evento", async () => {
    const t = await make();
    expect((await h.call("DELETE", `/api/tickets/${t.id}/agent-work`, as("admin"))).status).toBe(200);
    expect(await events("ticket.agent_work_ended")).toHaveLength(0);
  });

  it("outra organização não encerra: 404; projeto arquivado: 409", async () => {
    const t = await make();
    await mark("contributor", t.id, { working: true });
    expect(refusalOfResponse(await h.call("DELETE", `/api/tickets/${t.id}/agent-work`, as("outsider", OTHER_ORG)))).toMatchObject({ status: 404 });
    await h.pool.query("update projects set archived_at = now() where id = $1", [P()]);
    expect(refusalOfResponse(await h.call("DELETE", `/api/tickets/${t.id}/agent-work`, as("admin")))).toMatchObject({ status: 409 });
  });
});

describe("o marcador desliga junto com o ticket", () => {
  it.each(["done", "cancelled"])("ao ir para %s (motivo finished)", async (status) => {
    const t = await make();
    await mark("contributor", t.id, { working: true });
    expect((await h.call("PATCH", `/api/tickets/${t.id}`, as("admin"), { status })).status).toBe(200);
    expect((await detail(t.id)).agentWork).toBeNull();
    expect((await events("ticket.agent_work_ended"))[0].payload).toMatchObject({ reason: "finished" });
  });

  it("ao virar ideia, na subárvore inteira (motivo idea)", async () => {
    const root = await make();
    const child = await make({ parentId: root.id });
    await mark("contributor", root.id, { working: true });
    await mark("contributor", child.id, { working: true });
    expect((await h.call("POST", `/api/tickets/${root.id}/idea`, as("admin"))).status).toBe(200);
    expect((await detail(child.id)).agentWork).toBeNull();
    const ended = await events("ticket.agent_work_ended");
    expect(ended.map((e) => e.payload.reason)).toEqual(["idea", "idea"]);
  });

  it("ao ser movido para dentro de uma ideia, com os descendentes", async () => {
    const idea = await make({ idea: true });
    const moved = await make();
    const kid = await make({ parentId: moved.id });
    await mark("contributor", moved.id, { working: true });
    await mark("contributor", kid.id, { working: true });
    expect((await h.call("PATCH", `/api/tickets/${moved.id}`, as("admin"), { parentId: idea.id })).status).toBe(200);
    expect((await detail(kid.id)).agentWork).toBeNull();
    expect((await events("ticket.agent_work_ended")).map((e) => e.payload.reason)).toEqual(["idea", "idea"]);
  });
});

describe("atividade do ticket", () => {
  it("mostra agent_work_started (com until) e agent_work_ended (com reason); a renovação não aparece", async () => {
    const t = await make();
    const started = (await mark("contributor", t.id, { working: true })) as Marker;
    await mark("contributor", t.id, { working: true });
    await mark("contributor", t.id, { working: false });
    const entries = await feed(t.id);
    const a = entries.filter((e) => e.type === "agent_work_started");
    const b = entries.filter((e) => e.type === "agent_work_ended");
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ until: started.until, actor: { id: h.world().people.contributor } });
    expect(b).toHaveLength(1);
    expect(b[0]).toMatchObject({ reason: "agent" });
    expect(JSON.stringify(entries)).not.toContain('"note"');
  });
});

describe("isolamento entre organizações", () => {
  it("o marcador de um ticket de A não aparece nem some por uma sessão de B", async () => {
    const t = await make();
    await mark("contributor", t.id, { working: true });
    expect((await h.call("GET", `/api/tickets/${t.id}`, as("outsider", OTHER_ORG))).status).toBe(404);
    expect((await detail(t.id)).agentWork).not.toBeNull();
  });
});
