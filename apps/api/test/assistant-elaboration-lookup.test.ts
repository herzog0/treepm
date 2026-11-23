import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { recordQueries } from "./query-recorder.js";
import { as } from "./world.js";

// ADR 0052, item 4 (R6): a tarefa sugerida que já existe na árvore vira ligação, pela rota de elaboração; quem decide é o Claude.
const h = useHarness(AI_CONFIG, { timeouts: { relatedMs: 300, elaborationMs: 400 } });
const priv = () => h.world().projects.priv;
const REIMPORT = "Reimportar sem duplicar: guardar a origem de cada ticket";
const SUGGESTED = { title: "Guardar o vínculo entre cada ticket e o item na plataforma externa", description: "Registrar o identificador externo", motivo: "sem vínculo não há diff" };

/** A árvore da seed mais "Reimportar…" (PRIV-8), que o modelo não recebeu como relacionado. */
const seed = async () => {
  const tree = await seedTree(h.pool, h.world());
  const add = async (number: number, title: string, description: string, extra = ""): Promise<string> => {
    const r = await h.pool.query<{ id: string }>(
      `insert into tickets (org_id, project_id, number, parent_id, title, description, created_by_person_id ${extra ? ", " + extra.split("=")[0] : ""}) values ('org_A',$1,$2,null,$3,$4,$5 ${extra ? ", " + extra.split("=")[1] : ""}) returning id`,
      [priv(), number, title, description, h.world().people.manager],
    );
    await h.pool.query("update projects set next_ticket_number = $2 where id = $1", [priv(), number + 1]);
    return r.rows[0]!.id;
  };
  const reimport = await add(8, REIMPORT, "Guardar o vínculo de cada ticket com o item na plataforma externa, para não duplicar ao sincronizar.");
  return { tree, reimport, add };
};
const open = async () => {
  const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero sincronizar com o Jira" })).body.id as string;
  expect((await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Sincronizar tickets com o Jira", description: "Receber só o diff" })).status).toBe(200);
  return id;
};
const elaborate = (id: string) => h.call("POST", `/api/ticket-conversations/${id}/elaboration`, as("contributor"));
/** O Claude falso da segunda chamada: aponta, por título de candidato, o ticket que "já entrega" a sugerida (ou nenhum). */
const existing = (...titles: string[]) => {
  h.elaborator().matchReply = (task) => task.candidates.find((c) => titles.includes(c.title))?.key ?? null;
};
const suggest = (...tasks: { title: string; description: string; motivo: string }[]) => {
  h.elaborator().reply = () => ({ links: [], suggested: tasks });
};

describe("a sugerida que já existe vira ligação", () => {
  it("vira ligação do pai com o motivo da sugerida e sai das sugeridas; o título vem da árvore", async () => {
    await seed();
    suggest(SUGGESTED);
    existing(REIMPORT);
    const res = await elaborate(await open());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      links: [{ de: "pai", dependeDe: "PRIV-8", dependeDeTitle: REIMPORT, motivo: "sem vínculo não há diff" }],
      suggested: [],
      unavailable: null,
    });
  });

  it("null: continua sugerida", async () => {
    await seed();
    suggest(SUGGESTED);
    existing();
    const res = await elaborate(await open());
    expect(res.body.links).toEqual([]);
    expect(res.body.suggested).toHaveLength(1);
  });

  it("chave fora dos candidatos da sugerida é ignorada", async () => {
    await seed();
    suggest(SUGGESTED);
    h.elaborator().matchReply = () => "PRIV-999";
    const res = await elaborate(await open());
    expect(res.body.links).toEqual([]);
    expect(res.body.suggested).toHaveLength(1);
  });

  it("nenhuma chamada ao Jev nesta etapa (a decisão é do Claude)", async () => {
    await seed();
    suggest(SUGGESTED);
    existing(REIMPORT);
    await elaborate(await open());
    expect(h.related().calls).toHaveLength(0);
    expect(h.elaborator().matchCalls).toHaveLength(1);
  });

  it("ideia e cancelado não são alvo (a árvore é a viva)", async () => {
    const { reimport } = await seed();
    await h.pool.query("update tickets set idea_stage = 'new' where id = $1", [reimport]);
    suggest(SUGGESTED);
    existing(REIMPORT);
    const asIdea = await elaborate(await open());
    expect(asIdea.body.links).toEqual([]);
    expect(asIdea.body.suggested).toHaveLength(1);
    await h.pool.query("update tickets set idea_stage = null, status = 'cancelled' where id = $1", [reimport]);
    const cancelled = await elaborate(await open());
    expect(cancelled.body.links).toEqual([]);
    expect(cancelled.body.suggested).toHaveLength(1);
    for (const call of h.elaborator().matchCalls) expect(JSON.stringify(call)).not.toContain("Reimportar");
  });

  it("o duplicado nunca é alvo", async () => {
    const { tree } = await seed();
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: 0.5, sameRequest: c.title === "SAML" ? 0.95 : 0 }]));
    const id = await open();
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Entrar com SAML", description: "Login SAML" });
    expect((await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {})).body.duplicate?.id).toBe(tree.saml);
    suggest({ title: "Guardar o SAML do vínculo", description: "SAML e Reimportar", motivo: "ok" });
    h.elaborator().matchReply = (task) => task.candidates[0]?.key ?? null;
    const res = await elaborate(id);
    expect(h.elaborator().matchCalls.length).toBeGreaterThan(0);
    for (const call of h.elaborator().matchCalls) for (const task of call.tasks) expect(task.candidates.map((c) => c.title)).not.toContain("SAML");
    expect(res.body.links.map((l: { dependeDe: string }) => l.dependeDe)).not.toContain("PRIV-4");
  });

  it("ligação já proposta pelo modelo não duplica", async () => {
    await seed();
    h.elaborator().reply = () => ({ links: [{ de: "pai", dependeDe: "PRIV-8", motivo: "do modelo" }], suggested: [SUGGESTED] });
    existing(REIMPORT);
    // PRIV-8 precisa estar entre os relacionados para o modelo poder ligá-lo.
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: c.title === REIMPORT ? 0.9 : 0.3, sameRequest: 0 }]));
    const id = await open();
    await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
    const res = await elaborate(id);
    expect(res.body.links).toEqual([{ de: "pai", dependeDe: "PRIV-8", dependeDeTitle: REIMPORT, motivo: "do modelo" }]);
    expect(res.body.suggested).toEqual([]);
  });

  it("no limite de 5 ligações a sugerida é descartada, não volta como tarefa", async () => {
    const { add } = await seed();
    const keys: string[] = [];
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: c.title.startsWith("Painel") ? 0.9 : 0.1, sameRequest: 0 }]));
    for (let n = 0; n < 5; n += 1) {
      await add(20 + n, `Painel ${n} do sincronizar Jira diff`, "");
      keys.push(`PRIV-${20 + n}`);
    }
    h.elaborator().reply = () => ({ links: keys.map((dependeDe) => ({ de: "pai" as const, dependeDe, motivo: "m" })), suggested: [SUGGESTED] });
    existing(REIMPORT);
    const id = await open();
    await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
    const res = await elaborate(id);
    expect(res.body.links).toHaveLength(5);
    expect(res.body.links.map((l: { dependeDe: string }) => l.dependeDe)).not.toContain("PRIV-8");
    expect(res.body.suggested).toEqual([]);
  });
});

describe("o que vai ao Claude na segunda chamada", () => {
  it("só índice, título, descrição e motivo da sugerida e chave, título, trecho e situação dos candidatos: nada de ids, pessoas nem da citação do pedido", async () => {
    const { tree } = await seed();
    suggest(SUGGESTED);
    existing();
    await elaborate(await open());
    expect(h.elaborator().matchCalls).toHaveLength(1);
    const call = h.elaborator().matchCalls[0]!;
    expect(call.tasks).toHaveLength(1);
    const task = call.tasks[0]!;
    expect([task.index, task.title, task.description, task.motivo]).toEqual([0, SUGGESTED.title, SUGGESTED.description, SUGGESTED.motivo]);
    expect(task.candidates.length).toBeGreaterThan(0);
    for (const candidate of task.candidates) expect(Object.keys(candidate).sort()).toEqual(["excerpt", "key", "status", "title"]);
    const sent = JSON.stringify(call);
    for (const leak of ["Quero sincronizar com o Jira", h.world().people.manager, h.world().people.contributor, "org_A", tree.auth]) expect(sent, leak).not.toContain(leak);
  });
});

describe("robustez", () => {
  it("falha da segunda chamada: as sugeridas voltam como vieram", async () => {
    await seed();
    suggest(SUGGESTED);
    existing(REIMPORT);
    h.elaborator().matchFail = true;
    const res = await elaborate(await open());
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ links: [], suggested: [SUGGESTED], unavailable: null });
  });

  it("a segunda chamada não responde: cabe no prazo da rota e as sugeridas voltam", async () => {
    await seed();
    suggest(SUGGESTED);
    h.elaborator().matchHang = true;
    const started = Date.now();
    const res = await elaborate(await open());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.body).toMatchObject({ links: [], suggested: [SUGGESTED], unavailable: null });
  });

  it("sem sugeridas, a segunda chamada não acontece", async () => {
    await seed();
    h.elaborator().reply = () => ({ links: [], suggested: [] });
    await elaborate(await open());
    expect(h.elaborator().matchCalls).toHaveLength(0);
  });

  it("nenhuma consulta a mais ao banco por causa da etapa", async () => {
    await seed();
    const id = await open();
    suggest();
    const without = await recordQueries(() => elaborate(id));
    suggest(SUGGESTED, { ...SUGGESTED, title: "Guardar o vínculo de novo no item externo" });
    existing(REIMPORT);
    const withLookup = await recordQueries(() => elaborate(id));
    expect(h.elaborator().matchCalls.length).toBeGreaterThan(0);
    expect(withLookup.queries.length).toBe(without.queries.length);
  });
});

describe("diagnostics: só números e códigos", () => {
  type Diag = { model: { links: number; suggested: number }; dropped: { links: Record<string, number>; suggested: Record<string, number> }; lookups: { outcome: string; candidates: number; chosen: boolean }[]; timingsMs: { claude: number; lookup: number; secondCall: number } };
  it("conversão: o modelo devolveu 1 sugerida, a procura achou candidatos e o Claude apontou o ticket", async () => {
    await seed();
    suggest(SUGGESTED);
    existing(REIMPORT);
    const res = await elaborate(await open());
    const d = res.body.diagnostics as Diag;
    expect(d.model).toEqual({ links: 0, suggested: 1 });
    expect(d.lookups).toHaveLength(1);
    expect(d.lookups[0]).toMatchObject({ outcome: "converted", chosen: true });
    expect(d.lookups[0]!.candidates).toBeGreaterThan(0);
    expect(typeof d.timingsMs.claude).toBe("number");
    expect(typeof d.timingsMs.lookup).toBe("number");
    expect(typeof d.timingsMs.secondCall).toBe("number");
    expect(d.dropped.links["ancestor"]).toBe(0);
    expect(Object.values(d.dropped.suggested).every((n) => n === 0)).toBe(true);
  });

  it("nada de texto: nem título, descrição, motivo, nem texto do rascunho ou de ticket", async () => {
    await seed();
    suggest(SUGGESTED);
    existing(REIMPORT);
    const text = JSON.stringify((await elaborate(await open())).body.diagnostics);
    for (const leak of [SUGGESTED.title, SUGGESTED.description, SUGGESTED.motivo, REIMPORT, "Sincronizar tickets com o Jira", "Receber só o diff", "PRIV-"]) expect(text, leak).not.toContain(leak);
    expect(text).toMatch(/^[\w{}[\]":,.-]*$/);
  });

  it("descarte do servidor contado: sugerida com título repetido não chega à procura", async () => {
    await seed();
    suggest(SUGGESTED, SUGGESTED);
    existing();
    const d = (await elaborate(await open())).body.diagnostics as Diag;
    expect(d.model.suggested).toBe(2);
    expect(d.dropped.suggested["repeatedTitle"]).toBe(1);
    expect(d.lookups).toHaveLength(1);
    expect(d.lookups[0]!.outcome).toBe("kept");
  });

  it("falha da segunda chamada: lookup_failed", async () => {
    await seed();
    suggest(SUGGESTED);
    h.elaborator().matchFail = true;
    const d = (await elaborate(await open())).body.diagnostics as Diag;
    expect(d.lookups.map((l) => l.outcome)).toEqual(["lookup_failed"]);
  });

  it("ligação repetida aparece como desfecho", async () => {
    await seed();
    h.elaborator().reply = () => ({ links: [{ de: "pai", dependeDe: "PRIV-8", motivo: "do modelo" }], suggested: [SUGGESTED] });
    existing(REIMPORT);
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: c.title === REIMPORT ? 0.9 : 0.3, sameRequest: 0 }]));
    const id = await open();
    await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
    const d = (await elaborate(id)).body.diagnostics as Diag;
    expect(d.model.links).toBe(1);
    expect(d.lookups.map((l) => l.outcome)).toEqual(["dropped_duplicate"]);
  });

  it("indisponível não leva diagnostics", async () => {
    await seed();
    h.elaborator().hang = true;
    const res = await elaborate(await open());
    expect(res.body.unavailable).toBe("unavailable");
  });
});
