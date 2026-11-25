import { describe, expect, it } from "vitest";
import { useLinearHarness } from "./linear-support.js";
import { CATEGORIZE_CONFIG, categorizeAll, importedProject, linearTeam, wireFakes } from "./linear-categorize-support.js";
import type { Row } from "./linear-categorize-support.js";
import { as } from "./world.js";

// Privacidade da categorização (ADR 0060, seção 6): com a busca por significado ligada (Voyage falso), ao provedor vai SÓ título, descrição
// (cortada) e títulos dos filhos dos tickets, mais a árvore. Os dados contaminados abaixo não podem sair em nenhum campo.
const s = useLinearHarness({ ...CATEGORIZE_CONFIG, VOYAGE_API_KEY: "v-test", SEMANTIC_TRIAGE: "rrf" });
const { h } = s;
const open = () => h.world().projects.org;
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];

const ASSIGNEE = { id: "lin-user-1", email: "joao.responsavel@acme.com" };
const LEAK = ["joao.responsavel", "maria.solta@acme.com", "linear.app", "ENG-", "lin-user-1", "lp-alfa", "lp-beta", "lp-gama", "SEGREDO-comentario", "SEGREDO-contribuicao", "Area-Secreta", "person:", "@Ana", "Acme"];

describe("o que vai ao provedor na categorização", () => {
  it("só título, descrição e partes dos tickets, campo a campo; nada de responsável, comentário, área, endereço ou nome do Linear", async () => {
    wireFakes(s);
    const data = linearTeam();
    const solta1 = data.issues.find((issue) => issue.id === "s1");
    Object.assign(solta1 ?? {}, { assignee: ASSIGNEE, url: "https://linear.app/acme/issue/ENG-5/solta-1" });
    await importedProject(s, open(), { data });
    // Dados contaminados que ficam NO ticket mas fora do texto: responsável, comentário (com e-mail solto) e área.
    const solta1Id = (await q("select id from tickets where project_id = $1::uuid and title = 'Solta 1'", [open()]))[0]?.["id"] as string;
    const people = h.world().people;
    await q("insert into ticket_assignees (org_id, ticket_id, person_id) values ('org_A', $1::uuid, $2::uuid)", [solta1Id, people.admin]);
    await q("insert into ticket_comments (org_id, project_id, ticket_id, author_person_id, body) values ('org_A', $1::uuid, $2::uuid, $3::uuid, 'SEGREDO-comentario: escreva para maria.solta@acme.com')", [open(), solta1Id, people.admin]);
    const area = (await q("insert into areas (org_id, name) values ('org_A', 'Area-Secreta') returning id"))[0]?.["id"] as string;
    await q("insert into ticket_contributions (org_id, project_id, ticket_id, area_id, text, created_by_person_id) values ('org_A', $1::uuid, $2::uuid, $3::uuid, 'SEGREDO-contribuicao', $4::uuid)", [open(), solta1Id, area, people.admin]);
    // Texto com menção de pessoa (formato de menção): o ticket nem vai ao provedor.
    await q("update tickets set description = 'Falar com [@Ana](person:0190a1b2-0000-7000-8000-000000000001)' where project_id = $1::uuid and title = 'Solta 5'", [open()]);

    const view = await categorizeAll(s, open());
    expect(view.finished).toBe(true);

    // O provedor de vetores foi usado (a busca por significado estava ligada) e só recebeu texto de ticket.
    const embedded = h.embedder().calls.flatMap((call) => call.texts);
    expect(embedded.length).toBeGreaterThan(0);
    expect(embedded).toContain("Solta 1\n\nTexto da solta 1");

    // Campo a campo: o rascunho de cada chamada é exatamente { title, description } do ticket.
    const drafts = h.judge().calls.map((call) => call.draft as Record<string, unknown>);
    for (const draft of drafts) expect(Object.keys(draft).sort()).toEqual(["description", "title"]);
    expect(drafts.filter((draft) => draft["title"] === "Solta 1").every((draft) => draft["description"] === "Texto da solta 1")).toBe(true);
    expect(drafts.some((draft) => draft["title"] === "Alfa" && String(draft["description"]).startsWith("Descrição") === false)).toBe(true);
    // O que a árvore mostra de cada candidato da procura: só id, título e descrição.
    for (const call of h.judge().calls) for (const candidate of call.candidates) expect(Object.keys(candidate).every((key) => ["id", "title", "summary", "hasChildren"].includes(key)), JSON.stringify(Object.keys(candidate))).toBe(true);

    const sent = JSON.stringify([h.judge().calls, h.related().calls, h.affinity().calls, h.namer().calls, embedded]);
    expect(sent.length).toBeGreaterThan(1_000);
    expect(sent).toContain("Solta 1");
    expect(sent).toContain("Texto da solta 1");
    for (const forbidden of LEAK) expect(sent, forbidden).not.toContain(forbidden);
    for (const person of Object.values(people)) expect(sent).not.toContain(person);
    expect(sent).not.toMatch(/"(a1|a2|b1|g1|s[1-5]|x\d+)"/);
    expect(h.conversation().calls).toHaveLength(0);

    // O ticket com menção ficou a conferir, sem sugestão e sem decisão guardada.
    const list = (await h.call("GET", `/api/projects/${open()}/linear/categorize/to-check`, as("admin"))).body.items as { title: string; suggestedPath: unknown[] }[];
    expect(list.find((item) => item.title === "Solta 5")).toMatchObject({ suggestedPath: [] });
    expect(await q("select 1 from placement_decisions d join tickets t on t.id = d.ticket_id where t.title = 'Solta 5'")).toHaveLength(0);

    // Nada de conteúdo de ticket nos registros de atividade da categorização.
    const activity = JSON.stringify(await q("select payload from activity_events where payload->>'source' = 'linear_categorize'"));
    for (const forbidden of ["Texto da solta", ...LEAK]) expect(activity, forbidden).not.toContain(forbidden);
  });
});
