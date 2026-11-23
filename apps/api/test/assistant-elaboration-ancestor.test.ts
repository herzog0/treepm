import { describe, expect, it } from "vitest";
import { AI_CONFIG } from "./helpers.js";
import { seedTree } from "./assistant-tree.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";

// R6: um ticket não depende do próprio pai nem de um ancestral. A elaboração conhece o lugar escolhido (chosenPath) e a criação confere.
const h = useHarness(AI_CONFIG, { timeouts: { relatedMs: 300, elaborationMs: 2000 } });
const priv = () => h.world().projects.priv;
const rows = async (sql: string) => (await h.pool.query(sql)).rows;

/** Rascunho "Entrar com SAML corporativo", colocado por baixo de Auth > SSO (a decisão guardada tem chosenPath [Auth, SSO]). */
const placed = async () => {
  const tree = await seedTree(h.pool, h.world());
  h.related().verdict = (input) => Object.fromEntries(input.candidates.map((c) => [c.id, { sameSubject: 0.9, sameRequest: 0 }]));
  const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero SAML" })).body.id as string;
  await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Entrar com SAML corporativo", description: "Login único pela empresa" });
  const decision = (await h.call("POST", `/api/ticket-conversations/${id}/placement`, as("contributor"), {})).body;
  expect(decision.decision ?? decision).toBeTruthy();
  return { tree, id };
};
const elaborate = (id: string) => h.call("POST", `/api/ticket-conversations/${id}/elaboration`, as("contributor"));
type Diag = { dropped: { links: Record<string, number> } };

describe("elaboração: destino e ancestrais saem das ligações", () => {
  it("ligação do modelo a um ancestral (Auth, entre os relacionados) é descartada e contada; a outra fica", async () => {
    const { id } = await placed();
    h.elaborator().reply = () => ({
      links: [
        { de: "pai" as const, dependeDe: "PRIV-1", motivo: "ancestral" },
        { de: "pai" as const, dependeDe: "PRIV-4", motivo: "SAML existe" },
      ],
      suggested: [],
    });
    const res = await elaborate(id);
    expect(res.body.links.map((l: { dependeDe: string }) => l.dependeDe)).toEqual(["PRIV-4"]);
    expect((res.body.diagnostics as Diag).dropped.links["ancestor"]).toBe(1);
  });

  it("a segunda chamada nunca recebe o destino nem os ancestrais como candidatos", async () => {
    const { id } = await placed();
    h.elaborator().reply = () => ({ links: [], suggested: [{ title: "Configurar o SSO e o Auth", description: "SSO Auth Login", motivo: "m" }] });
    h.elaborator().matchReply = (task) => task.candidates[0]?.key ?? null;
    const res = await elaborate(id);
    const titles = h.elaborator().matchCalls.flatMap((c) => c.tasks.flatMap((t) => t.candidates.map((cand) => cand.title)));
    expect(titles).not.toContain("SSO");
    expect(titles).not.toContain("Auth");
    expect(res.body.links.map((l: { dependeDe: string }) => l.dependeDe)).not.toEqual(expect.arrayContaining(["PRIV-1"]));
  });
});

describe("criação: ligação a ancestral é descartada com aviso", () => {
  it("o alvo que é o pai escolhido ou ancestral dele vira aviso 'ancestor'; o outro liga", async () => {
    const tree = await seedTree(h.pool, h.world());
    const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero SAML" })).body.id as string;
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Entrar com SAML corporativo", description: "Login único" });
    const res = await h.call("POST", `/api/ticket-conversations/${id}/ticket`, as("contributor"), {
      parentId: tree.sso,
      links: [{ de: "pai", dependeDe: "PRIV-3" }, { de: "pai", dependeDe: "PRIV-1" }, { de: "pai", dependeDe: "PRIV-2" }],
    });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.warnings).toEqual([
      { code: "link_discarded", de: "pai", dependeDe: "PRIV-3", reason: "ancestor" },
      { code: "link_discarded", de: "pai", dependeDe: "PRIV-1", reason: "ancestor" },
    ]);
    expect(await rows("select t.number as to_n from ticket_relations r join tickets t on t.id = r.to_ticket_id where r.kind = 'depends_on' order by 1")).toEqual([{ to_n: 2 }]);
  });

  it("sem pai escolhido (raiz) nada é ancestral", async () => {
    await seedTree(h.pool, h.world());
    const id = (await h.call("POST", `/api/projects/${priv()}/ticket-conversations`, as("contributor"), { message: "Quero SAML" })).body.id as string;
    await h.call("PATCH", `/api/ticket-conversations/${id}/draft`, as("contributor"), { title: "Entrar com SAML corporativo", description: "Login único" });
    const res = await h.call("POST", `/api/ticket-conversations/${id}/ticket`, as("contributor"), { parentId: null, links: [{ de: "pai", dependeDe: "PRIV-1" }] });
    expect(res.status).toBe(201);
    expect(res.body.warnings).toEqual([]);
  });
});
