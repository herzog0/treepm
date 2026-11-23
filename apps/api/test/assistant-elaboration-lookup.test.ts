import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { recordQueries } from "./query-recorder.js";
import { as } from "./world.js";

// ADR 0052, item 4 (R4): a tarefa sugerida que já existe na árvore vira ligação, pela rota de elaboração.
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
/** O Jev falso: "pede a mesma coisa" por título do candidato, só quando a requisição é de uma sugerida (não do rascunho). */
const requestOdds = (odds: Record<string, number>) => {
  h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: 0.3, sameRequest: input.draft.title.startsWith("Guardar o vínculo") ? (odds[c.title] ?? 0) : 0 }]));
};
const suggest = (...tasks: { title: string; description: string; motivo: string }[]) => {
  h.elaborator().reply = () => ({ links: [], suggested: tasks });
};

describe("a sugerida que já existe vira ligação", () => {
  it("vira ligação do pai com o motivo da sugerida e sai das sugeridas; o título vem da árvore", async () => {
    await seed();
    suggest(SUGGESTED);
    requestOdds({ [REIMPORT]: 0.9 });
    const res = await elaborate(await open());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      links: [{ de: "pai", dependeDe: "PRIV-8", dependeDeTitle: REIMPORT, motivo: "sem vínculo não há diff" }],
      suggested: [],
      unavailable: null,
    });
  });

  it("sem equivalente na árvore, continua sugerida", async () => {
    await seed();
    suggest(SUGGESTED);
    requestOdds({ [REIMPORT]: 0.4 });
    const res = await elaborate(await open());
    expect(res.body.links).toEqual([]);
    expect(res.body.suggested).toHaveLength(1);
  });

  it("o limiar: 0,7 liga e 0,69 não", async () => {
    await seed();
    suggest(SUGGESTED);
    requestOdds({ [REIMPORT]: 0.69 });
    expect((await elaborate(await open())).body.links).toEqual([]);
    requestOdds({ [REIMPORT]: 0.7 });
    expect((await elaborate(await open())).body.links).toHaveLength(1);
  });

  it("ideia e cancelado não são alvo (a árvore é a viva)", async () => {
    const { reimport } = await seed();
    await h.pool.query("update tickets set idea_stage = 'new' where id = $1", [reimport]);
    suggest(SUGGESTED);
    requestOdds({ [REIMPORT]: 0.99 });
    const asIdea = await elaborate(await open());
    expect(asIdea.body.links).toEqual([]);
    expect(asIdea.body.suggested).toHaveLength(1);
    await h.pool.query("update tickets set idea_stage = null, status = 'cancelled' where id = $1", [reimport]);
    const cancelled = await elaborate(await open());
    expect(cancelled.body.links).toEqual([]);
    expect(cancelled.body.suggested).toHaveLength(1);
    for (const call of h.related().calls) expect(JSON.stringify(call)).not.toContain("Reimportar");
  });

  it("o duplicado nunca é alvo", async () => {
    const { tree } = await seed();
    // SAML (PRIV-4) é o duplicado da procura; a sugerida parece com ele.
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: 0.5, sameRequest: c.title === "SAML" || (c.title === REIMPORT && input.draft.title.startsWith("Guardar")) ? 0.95 : 0 }]));
    const id = await open();
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Entrar com SAML", description: "Login SAML" });
    expect((await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {})).body.duplicate?.id).toBe(tree.saml);
    h.related().calls.length = 0;
    suggest({ title: "Guardar o SAML do vínculo", description: "SAML e Reimportar", motivo: "ok" });
    const res = await elaborate(id);
    expect(h.related().calls.length).toBeGreaterThan(0);
    for (const call of h.related().calls) expect(call.candidates.map((c) => c.title)).not.toContain("SAML");
    expect(res.body.links.map((l: { dependeDe: string }) => l.dependeDe)).not.toContain("PRIV-4");
  });

  it("ligação já proposta pelo modelo não duplica", async () => {
    await seed();
    h.elaborator().reply = () => ({ links: [{ de: "pai", dependeDe: "PRIV-8", motivo: "do modelo" }], suggested: [SUGGESTED] });
    requestOdds({ [REIMPORT]: 0.9 });
    // PRIV-8 precisa estar entre os relacionados para o modelo poder ligá-lo.
    h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: c.title === REIMPORT && !input.draft.title.startsWith("Guardar") ? 0.9 : 0.3, sameRequest: input.draft.title.startsWith("Guardar") ? (c.title === REIMPORT ? 0.9 : 0) : 0 }]));
    const id = await open();
    await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
    const res = await elaborate(id);
    expect(res.body.links).toEqual([{ de: "pai", dependeDe: "PRIV-8", dependeDeTitle: REIMPORT, motivo: "do modelo" }]);
    expect(res.body.suggested).toEqual([]);
  });

  it("no limite de 5 ligações a sugerida é descartada, não volta como tarefa", async () => {
    const { add } = await seed();
    const keys: string[] = [];
    h.related().verdict = (input) =>
      Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: input.draft.title.startsWith("Guardar") ? 0.3 : c.title.startsWith("Painel") ? 0.9 : 0.1, sameRequest: input.draft.title.startsWith("Guardar") && c.title === REIMPORT ? 0.9 : 0 }]));
    for (let n = 0; n < 5; n += 1) {
      await add(20 + n, `Painel ${n} do sincronizar Jira diff`, "");
      keys.push(`PRIV-${20 + n}`);
    }
    h.elaborator().reply = () => ({ links: keys.map((dependeDe) => ({ de: "pai" as const, dependeDe, motivo: "m" })), suggested: [SUGGESTED] });
    const id = await open();
    await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {});
    const res = await elaborate(id);
    expect(res.body.links).toHaveLength(5);
    expect(res.body.links.map((l: { dependeDe: string }) => l.dependeDe)).not.toContain("PRIV-8");
    expect(res.body.suggested).toEqual([]);
  });
});

describe("o que vai ao Jev", () => {
  it("título e descrição da sugerida e título e trecho dos candidatos: nada de ids, motivo, pessoas nem da citação do pedido", async () => {
    const { reimport, tree } = await seed();
    suggest(SUGGESTED);
    requestOdds({});
    await elaborate(await open());
    expect(h.related().calls).toHaveLength(1);
    const call = h.related().calls[0]!;
    expect(call.draft).toEqual({ title: SUGGESTED.title, description: SUGGESTED.description });
    expect(call.candidates.length).toBeGreaterThan(0);
    for (const candidate of call.candidates) expect(Object.keys(candidate).sort()).toEqual(["excerpt", "id", "title"]);
    const sent = JSON.stringify(call);
    for (const leak of [SUGGESTED.motivo, "Quero sincronizar com o Jira", h.world().people.manager, h.world().people.contributor, "org_A", "PRIV-", tree.auth]) expect(sent, leak).not.toContain(leak);
    expect(reimport).toBeTruthy();
  });
});

describe("robustez", () => {
  it("falha do Jev: as sugeridas voltam como vieram", async () => {
    await seed();
    suggest(SUGGESTED);
    requestOdds({ [REIMPORT]: 0.99 });
    h.related().fail = true;
    const res = await elaborate(await open());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({ links: [], suggested: [SUGGESTED], unavailable: null });
  });

  it("o Jev não responde: cabe no prazo da rota e as sugeridas voltam", async () => {
    await seed();
    suggest(SUGGESTED);
    h.related().hang = true;
    const started = Date.now();
    const res = await elaborate(await open());
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(res.body).toEqual({ links: [], suggested: [SUGGESTED], unavailable: null });
  });

  it("sem sugeridas, o Jev não é chamado", async () => {
    await seed();
    h.elaborator().reply = () => ({ links: [], suggested: [] });
    await elaborate(await open());
    expect(h.related().calls).toHaveLength(0);
  });

  it("nenhuma consulta a mais ao banco por causa da etapa", async () => {
    await seed();
    const id = await open();
    suggest();
    const without = await recordQueries(() => elaborate(id));
    suggest(SUGGESTED, { ...SUGGESTED, title: "Guardar o vínculo de novo no item externo" });
    requestOdds({ [REIMPORT]: 0.9 });
    const withLookup = await recordQueries(() => elaborate(id));
    expect(h.related().calls.length).toBeGreaterThan(0);
    expect(withLookup.queries.length).toBe(without.queries.length);
  });
});
