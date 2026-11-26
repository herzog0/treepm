import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { useLinearHarness } from "./linear-support.js";
import type { FakeComment, FakeIssue } from "./linear-support.js";
import { CATEGORIZE_CONFIG, categorizeAll, importedProject, linearTeam, runImport, wireFakes } from "./linear-categorize-support.js";
import type { Row } from "./linear-categorize-support.js";
import { as } from "./world.js";

// Comentários do Linear continuam FORA da IA (ADR 0061, seção 6; TREEPM-477): nenhum corpo, nenhum nome de autor do Linear em pedido a
// Anthropic, TypeSafe ou Voyage, em nenhum caminho (procura do lugar, categorização, vetores, conversa). Sentinelas improváveis.
const s = useLinearHarness({ ...CATEGORIZE_CONFIG, VOYAGE_API_KEY: "v-test", SEMANTIC_TRIAGE: "rrf" });
const { h } = s;
const open = () => h.world().projects.org;
const q = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows as Row[];
const BODY = "Corpo Sentinela Kalimera do comentário";
const AUTHOR = "Autora Sentinela Ifigênia";
const EMAIL = "autora.sentinela@linear.test";

describe("comentário importado não vai a provedor de IA", () => {
  it("importa, sincroniza, abre o ticket, categoriza e conversa: os provedores nunca veem corpo nem autor do Linear", async () => {
    wireFakes(s);
    const data = linearTeam();
    const issue = data.issues[0] as FakeIssue;
    const list: FakeComment[] = [
      { id: "cs-1", issue: issue.id, body: BODY, user: { id: "u-s", name: AUTHOR, email: EMAIL } },
      { id: "cs-2", issue: issue.id, body: `Resposta ${BODY}`, parent: { id: "cs-1", body: BODY }, bot: AUTHOR },
    ];
    data.comments = list;
    await importedProject(s, open(), { data });
    list[0] = { ...(list[0] as FakeComment), body: `${BODY} editado`, editedAt: "2026-11-20T10:00:00.000Z" };
    await runImport(s, open());
    const ticket = (await q("select ticket_id from ticket_external_refs where external_id = $1", [issue.id]))[0]!["ticket_id"];
    await h.call("GET", `/api/tickets/${String(ticket)}/activity`, as("admin"));
    const view = await categorizeAll(s, open());
    expect(view.finished).toBe(true);
    // A varredura vê o dado: os comentários estão no banco.
    expect(JSON.stringify(await q("select body, external_author_name from ticket_comments"))).toContain(AUTHOR);
    const embedded = h.embedder().calls.flatMap((call) => call.texts);
    const sent = JSON.stringify([h.judge().calls, h.related().calls, h.affinity().calls, h.namer().calls, h.conversation().calls, embedded]);
    expect(sent.length).toBeGreaterThan(500);
    for (const forbidden of ["Sentinela", "Kalimera", "Ifigênia", EMAIL]) expect(sent, forbidden).not.toContain(forbidden);
    expect(JSON.stringify(await q("select * from ticket_comments")) + JSON.stringify(await q("select * from activity_events"))).not.toContain(EMAIL);
  });
});

describe("estrutura: só a importação, a página do ticket e o MCP (com o alcance) leem comentários", () => {
  const SRC = join(__dirname, "..", "src");
  // A tabela e as colunas pelo nome, e também a leitura pela RELAÇÃO do Prisma (`include`/`select: { comments: … }`, `_count` de
  // comentários), que não cita a tabela (C2, item 7).
  const READS = /ticketComment\b|ticket_comments|externalItemRef|external_item_refs|externalAuthorName|external_author_name|\bcomments\s*:\s*(?:true\b|\{)|_count\s*:\s*\{[^}]*\bcomments\b/;
  // A contagem de comentários por contribuição: `ticket-contributions.read.ts` (pela relação) e `ticket-contributions.service.ts` (ao remover).
  const ALLOWED = new Set(["linear/linear-import.service.ts", "tickets/ticket-comments.service.ts", "tickets/ticket-activity.service.ts", "tickets/ticket-contributions.read.ts", "tickets/ticket-contributions.service.ts", "mcp/mcp-people-read.ts",
    // As origens de RELAÇÃO (ADR 0061, fatia 3) também moram em `external_item_refs`: só este arquivo as lê fora da importação.
    "linear/linear-relation-origins.ts"]);
  it("o padrão pega a leitura pela relação, e não pega nomes parecidos", () => {
    for (const snippet of ["include: { comments: true }", "select: { id: true, comments: { select: { body: true } } }", "_count: { select: { comments: true } }", "_count: { select: { comments: { where: { removedAt: null } } } }", "tx.ticketComment.findMany()"]) expect(READS.test(snippet), snippet).toBe(true);
    for (const snippet of ["commentsCreated: 0", "const comments = []", "commentCount: 1"]) expect(READS.test(snippet), snippet).toBe(false);
    // Filtrar por `kind: "relation"` não libera a leitura: o `OR` (ou um `select` de `applied`) pode trazer as origens de comentário.
    for (const snippet of [
      `const refs = await tx.externalItemRef.findMany({ where: { kind: "relation", projectId }, select: { applied: true, externalId: true } }); provider.send(JSON.stringify(refs));`,
      `const refs = await tx.externalItemRef.findMany({ where: { kind: "relation", OR: [{ kind: "comment" }, {}] } });`,
    ])
      expect(READS.test(snippet), snippet).toBe(true);
  });
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => (statSync(join(dir, name)).isDirectory() ? walk(join(dir, name)) : name.endsWith(".ts") ? [join(dir, name)] : []));
  it("nenhum arquivo de assistente, procura, vetores, resumo ou categorização lê comentários", () => {
    const offenders = walk(SRC)
      .map((file) => file.slice(SRC.length + 1))
      .filter((file) => !ALLOWED.has(file) && READS.test(readFileSync(join(SRC, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
