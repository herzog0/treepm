import { describe, expect, it } from "vitest";
import { LINEAR_CONFIG } from "./helpers.js";
import { categorizePath, importedProject } from "./linear-categorize-support.js";
import { useLinearHarness } from "./linear-support.js";
import { as } from "./world.js";

// Linear ligado e IA NÃO configurada neste ambiente: a categorização informa o motivo e nada abre.
const s = useLinearHarness(LINEAR_CONFIG);
const { h } = s;
const open = () => h.world().projects.org;

describe("categorização sem a IA configurada", () => {
  it("a leitura diz o motivo sem chamar ninguém, e abrir responde 503", async () => {
    await importedProject(s, open());
    const overview = await h.call("GET", categorizePath(open()), as("admin"));
    expect(overview.status).toBe(200);
    expect(overview.body).toMatchObject({ available: false, reason: "assistant_not_configured", candidates: 8, run: null });
    const opened = await h.call("POST", categorizePath(open()), as("admin"), {});
    expect(opened.status).toBe(503);
    expect(opened.body.error.code).toBe("assistant_not_configured");
    expect((await h.pool.query("select 1 from external_import_runs where mode = 'categorize'")).rowCount).toBe(0);
  });
});
