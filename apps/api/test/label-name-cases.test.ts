/* eslint-disable @typescript-eslint/no-explicit-any */
import { LABEL_NAME_CASES, labelNameKey, labelNameRefused } from "@treepm/domain";
import { describe, expect, it } from "vitest";
import { seedProject, useMcpHarness } from "./mcp-support.js";
import { ORG, as } from "./world.js";

// Etiquetas (ADR 0065; TREEPM-466), revisão E1, itens 1 e 2: o domínio decide antes do banco. O nome cuja chave NFKC passa do CHECK
// `project_labels_name_key_check` (240) e o nome feito só de invisíveis são inválidos: 400 `label_name_invalid` na API, recusa de entrada
// no MCP (a sincronização do Linear os ignora e conta: `linear-labels.test.ts`). Invisíveis saem do nome: "bug", "bug\u200b" e "b\u00adug" são a
// mesma etiqueta. A MESMA lista de casos do teste do domínio é conferida aqui contra os CHECKs de verdade.
const h = useMcpHarness();
const priv = () => h.world().projects.priv;
const q = async (sql: string, params: unknown[] = []) => h.rows(sql, params);
const FDFA = "\ufdfa";
const BIG = FDFA.repeat(14); // 14 pontos de código; a chave NFKC tem 252.

const ticket = async (): Promise<string> => {
  const res = await h.call("POST", `/api/projects/${priv()}/tickets`, as("admin"), { title: "T" });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.id as string;
};

describe("a lista compartilhada contra os CHECKs do banco", () => {
  it("o banco e `labelNameRefused` concordam em cada caso", async () => {
    const client = await h.pool.connect();
    const refusedByDb = async (name: string): Promise<boolean> => {
      await client.query("begin");
      try {
        await client.query("select set_config('app.org_id', $1, true)", [ORG]);
        await client.query("insert into project_labels (org_id, project_id, name, name_key, color) values ($1, $2, $3, $4, 'gray')", [ORG, priv(), name, labelNameKey(name)]);
        return false;
      } catch (error) {
        if ((error as { code?: string }).code !== "23514") throw error;
        return true;
      } finally {
        await client.query("rollback");
      }
    };
    try {
      const seen: { name: string; db: boolean; domain: boolean }[] = [];
      for (const { name } of LABEL_NAME_CASES) seen.push({ name, db: await refusedByDb(name), domain: labelNameRefused(name) });
      expect(seen.some((item) => item.db) && seen.some((item) => !item.db)).toBe(true);
      expect(seen.filter((item) => item.db !== item.domain)).toEqual([]);
      expect(seen.map((item) => item.db)).toEqual(LABEL_NAME_CASES.map((item) => item.refused));
    } finally {
      client.release();
    }
  });
});

describe("pela API: inválido é 400, nunca 500", () => {
  it("criar, pôr por nome e renomear com a chave longa demais: 400 label_name_invalid e nada muda", async () => {
    const created = await h.call("POST", `/api/projects/${priv()}/labels`, as("admin"), { name: BIG });
    expect(created.status, JSON.stringify(created.body)).toBe(400);
    expect(created.body.error.code).toBe("label_name_invalid");
    const t = await ticket();
    const put = await h.call("POST", `/api/tickets/${t}/labels`, as("admin"), { add: [{ name: FDFA.repeat(20) }] });
    expect(put.status, JSON.stringify(put.body)).toBe(400);
    expect(put.body.error.code).toBe("label_name_invalid");
    const ok = await h.call("POST", `/api/projects/${priv()}/labels`, as("admin"), { name: "Bug" });
    expect(ok.status).toBe(201);
    const renamed = await h.call("PATCH", `/api/projects/${priv()}/labels/${ok.body.id}`, as("admin"), { name: BIG });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(400);
    expect(renamed.body.error.code).toBe("label_name_invalid");
    expect((await q("select name from project_labels where project_id = $1", [priv()])).map((row) => row["name"])).toEqual(["Bug"]);
  });

  it("nome só de invisíveis é inválido; com invisíveis é o mesmo nome sem eles", async () => {
    for (const name of ["\u200b", "\u2060\u200d", "\u00ad", "\u202e"]) {
      const res = await h.call("POST", `/api/projects/${priv()}/labels`, as("admin"), { name });
      expect(res.status, JSON.stringify(name)).toBe(400);
      expect(res.body.error.code).toBe("label_name_invalid");
    }
    expect((await h.call("POST", `/api/projects/${priv()}/labels`, as("admin"), { name: "bug" })).status).toBe(201);
    for (const name of ["bug\u200b", "b\u00adug", "\u202ebug"]) {
      const res = await h.call("POST", `/api/projects/${priv()}/labels`, as("admin"), { name });
      expect(res.status, JSON.stringify(name)).toBe(409);
      expect(res.body.error.code).toBe("label_name_taken");
    }
    // Pelo ticket, o nome com invisível reusa a etiqueta que já existe.
    const t = await ticket();
    const put = await h.call("POST", `/api/tickets/${t}/labels`, as("admin"), { add: [{ name: "BU\u200bG" }] });
    expect(put.status, JSON.stringify(put.body)).toBe(200);
    expect(put.body.labels.map((label: any) => label.name)).toEqual(["bug"]);
    expect((await q("select name from project_labels where project_id = $1", [priv()])).map((row) => row["name"])).toEqual(["bug"]);
  });
});

describe("pelo MCP", () => {
  it("update_ticket com a chave longa demais: recusa de entrada, não erro interno", async () => {
    await seedProject(h.pool, priv(), h.world().people.manager, h.world().people.contributor);
    await h.pool.query("update organizations set mcp_enabled = true, mcp_write_enabled = true where org_id = $1", [ORG]);
    const res = await h.create("contributor", priv(), { scope: "write" });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const out = await h.tool(res.body.token as string, "PRIV", "update_ticket", { key: "PRIV-1", addLabels: [FDFA.repeat(20)] });
    expect(out.isError).toBe(true);
    expect(out.text).toMatch(/label name/i);
    expect(out.text).not.toMatch(/went wrong/i);
    expect(await q("select id from project_labels where project_id = $1", [priv()])).toEqual([]);
  });
});
