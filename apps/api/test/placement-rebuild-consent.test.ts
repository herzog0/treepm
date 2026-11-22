import { APP_URL } from "@treepm/db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { bootApp } from "../scripts/placement-rebuild/app.js";
import { requireAssistantConsentOfOrg } from "../scripts/placement-rebuild/consent.js";
import { loadConfig } from "../src/config.js";
import { ownerPoolWithCleanup, truncateAll } from "./helpers.js";

process.env["DATABASE_URL"] = APP_URL;
process.env["CLERK_SECRET_KEY"] = "fake";
process.env["CLERK_PUBLISHABLE_KEY"] = "fake";
process.env["APP_ORIGIN"] = "http://127.0.0.1:4310";
process.env["ANTHROPIC_API_KEY"] = "fake";
process.env["TYPESAFE_API_KEY"] = "fake";

const pool = ownerPoolWithCleanup();
const config = () => loadConfig(process.env);
let personId = "";

const seed = async (orgId: string) => {
  await pool.query("insert into organizations (org_id, name, slug) values ($1, $1, $1)", [orgId]);
  const r = await pool.query<{ id: string }>("insert into people (org_id, clerk_user_id, display_name, email, clerk_role) values ($1, 'u_cli', 'A', 'a@x.test', 'admin') returning id", [orgId]);
  personId = r.rows[0]?.id ?? "";
};
const consent = (orgId: string, kind = "assistant", version = "rascunho-1", withdrawn = false) =>
  pool.query(
    `insert into organization_consents (org_id, kind, document_version, accepted_by_person_id${withdrawn ? ", withdrawn_at, withdrawn_by_person_id" : ""}) values ($1, $2, $3, $4${withdrawn ? ", now(), $4" : ""})`,
    [orgId, kind, version, personId],
  );

beforeAll(async () => {
  await truncateAll(pool);
});
beforeEach(async () => {
  await truncateAll(pool);
});
afterAll(async () => {
  await truncateAll(pool);
  await pool.end();
});

describe("ferramenta de linha de comando: aceite do assistente", () => {
  it("recusa sem aceite, com mensagem clara que diz onde aceitar", async () => {
    await seed("org_cli");
    await expect(requireAssistantConsentOfOrg(config(), "org_cli")).rejects.toThrow(/org_cli.*aceite do assistente de IA.*Configurações/s);
  });

  it("recusa aceite retirado e aceite de versão antiga", async () => {
    await seed("org_cli");
    await consent("org_cli", "assistant", "rascunho-1", true);
    await expect(requireAssistantConsentOfOrg(config(), "org_cli")).rejects.toThrow(/aceite/);
    await pool.query("truncate organization_consents");
    await consent("org_cli", "assistant", "rascunho-0");
    await expect(requireAssistantConsentOfOrg(config(), "org_cli")).rejects.toThrow(/aceite/);
  });

  it("passa com o aceite em vigor e o aceite de uma organização não vale para outra", async () => {
    await seed("org_cli");
    await consent("org_cli");
    await expect(requireAssistantConsentOfOrg(config(), "org_cli")).resolves.toBeUndefined();
    await expect(requireAssistantConsentOfOrg(config(), "org_outra")).rejects.toThrow(/aceite/);
  });

  it("o boot dos comandos que usam IA recusa antes de subir a API, com provedores falsos também", async () => {
    await seed("org_cli");
    for (const fakeProviders of [true, false]) {
      await expect(
        bootApp({ org: "org_cli", user: "u_cli", role: "org:admin", fakeProviders, fake503First: 0, fake503JudgeAt: 0, needsAi: true }),
      ).rejects.toThrow(/aceite do assistente de IA/);
    }
  });

  it("os comandos que só gerenciam tickets (needsAi falso) não conferem nada", async () => {
    await seed("org_cli");
    const booted = await bootApp({ org: "org_cli", user: "u_cli", role: "org:admin", fakeProviders: false, fake503First: 0, fake503JudgeAt: 0, needsAi: false });
    await booted.close();
  });

  it("nada na ferramenta grava aceite", async () => {
    await seed("org_cli");
    await requireAssistantConsentOfOrg(config(), "org_cli").catch(() => undefined);
    expect((await pool.query("select 1 from organization_consents")).rowCount).toBe(0);
  });
});
