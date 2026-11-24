import { describe, expect, it } from "vitest";
import { AI_CONFIG, sessionHeader } from "./helpers.js";
import { useHarness } from "./harness.js";
import { as, giveConsent } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(AI_CONFIG, { consent: false });
const rows = async (sql: string, params: unknown[] = []) => (await h.pool.query(sql, params)).rows;
const errorOf = (res: { body: { error?: { code: string } } }) => res.body.error?.code;
const VERSION = "rascunho-3";

const state = (who: Who | "outsider" = "admin", org = "org_A") => h.call("GET", "/api/organization/ai-consent", as(who, org));
const accept = (kind: string, who: Who | "outsider" = "admin", org = "org_A", version: string = VERSION) =>
  h.call("PUT", `/api/organization/ai-consent/${kind}`, as(who, org), { version });
const withdraw = (kind: string, who: Who | "outsider" = "admin", org = "org_A") =>
  h.call("DELETE", `/api/organization/ai-consent/${kind}`, as(who, org));
const consents = (org = "org_A") =>
  rows("select kind, document_version, withdrawn_at, withdrawn_by_person_id, accepted_by_person_id from organization_consents where org_id = $1 order by accepted_at, id", [org]);
const events = () => rows("select kind, subject_type, subject_id, actor_person_id, payload from activity_events where kind like 'organization.ai_consent%' order by occurred_at, id");
const connectGithub = () =>
  h.pool.query("insert into github_installations (org_id, installation_id, account_login, account_type, repository_selection) values ('org_A', 4242, 'acme', 'Organization', 'all')");

describe("GET /organization/ai-consent", () => {
  it("sem aceite: nada em vigor, a versão atual e a leitura de código não oferecida", async () => {
    const res = await state();
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      currentVersion: VERSION,
      assistant: { inForce: false, version: null, acceptedBy: null, acceptedAt: null, outdated: false },
      codeReading: { inForce: false, version: null, acceptedBy: null, acceptedAt: null, outdated: false, offerable: false, githubConnected: false },
    });
  });

  it("qualquer membro lê, com quem aceitou (nome) e quando", async () => {
    await accept("assistant");
    for (const who of ["plain", "reader", "teamAdmin"] as const) {
      const res = await state(who);
      expect(res.status).toBe(200);
      expect(res.body.assistant).toMatchObject({ inForce: true, version: VERSION, acceptedBy: "Nome admin", outdated: false });
      expect(Date.parse(res.body.assistant.acceptedAt)).not.toBeNaN();
    }
  });

  it("aceite de versão antiga aparece como desatualizado e não em vigor", async () => {
    await giveConsent(h.pool, "org_A", h.world().people.admin, "assistant", "rascunho-0");
    const res = await state();
    expect(res.body.assistant).toMatchObject({ inForce: false, version: "rascunho-0", outdated: true });
  });

  it("code_reading só é oferecido com o GitHub ligado na organização e o assistente em vigor", async () => {
    expect((await state()).body.codeReading).toMatchObject({ offerable: false, githubConnected: false });
    await connectGithub();
    expect((await state()).body.codeReading).toMatchObject({ offerable: false, githubConnected: true });
    await accept("assistant");
    expect((await state()).body.codeReading).toMatchObject({ offerable: true, githubConnected: true });
  });
});

describe("PUT /organization/ai-consent/:kind (aceitar)", () => {
  it("só o administrador: os demais recebem 403 e nada é gravado", async () => {
    for (const who of ["teamAdmin", "manager", "contributor", "reader", "plain"] as const) {
      expect((await accept("assistant", who)).status, who).toBe(403);
    }
    expect(await consents()).toHaveLength(0);
    expect(await events()).toHaveLength(0);
  });

  it("grava a linha com a versão, a pessoa e um evento no assunto organização", async () => {
    const res = await accept("assistant");
    expect(res.status).toBe(200);
    expect(res.body.assistant).toMatchObject({ inForce: true, version: VERSION, acceptedBy: "Nome admin" });
    const [row] = await consents();
    expect(row).toMatchObject({ kind: "assistant", document_version: VERSION, withdrawn_at: null, accepted_by_person_id: h.world().people.admin });
    expect(await events()).toEqual([
      {
        kind: "organization.ai_consent_accepted",
        subject_type: "organization",
        subject_id: "org_A",
        actor_person_id: h.world().people.admin,
        payload: { kind: "assistant", version: VERSION },
      },
    ]);
  });

  it("é idempotente: aceitar de novo o que já vale não cria linha nem evento", async () => {
    await accept("assistant");
    const again = await accept("assistant");
    expect(again.status).toBe(200);
    expect(await consents()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });

  it("com versão antiga em vigor cria a linha nova e encerra a antiga", async () => {
    await giveConsent(h.pool, "org_A", h.world().people.manager, "assistant", "rascunho-0");
    const res = await accept("assistant");
    expect(res.body.assistant).toMatchObject({ inForce: true, version: VERSION, outdated: false });
    const list = await consents();
    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({ document_version: "rascunho-0", withdrawn_by_person_id: h.world().people.admin });
    expect(list[0]?.withdrawn_at).toBeInstanceOf(Date);
    expect(list[1]).toMatchObject({ document_version: VERSION, withdrawn_at: null });
    expect(await events()).toHaveLength(1);
  });

  it("recusa uma versão que não é a atual (os documentos mudaram enquanto a tela estava aberta)", async () => {
    const res = await accept("assistant", "admin", "org_A", "rascunho-0");
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("consent_version_changed");
    expect(await consents()).toHaveLength(0);
  });

  it("tipo desconhecido e corpo inválido dão 400", async () => {
    expect((await accept("outro")).status).toBe(400);
    expect((await h.call("PUT", "/api/organization/ai-consent/assistant", as("admin"), {})).status).toBe(400);
  });

  it("code_reading sem o assistente em vigor: 409 assistant_consent_required_first", async () => {
    await connectGithub();
    const res = await accept("code_reading");
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("assistant_consent_required_first");
    expect(await consents()).toHaveLength(0);
  });

  it("code_reading sem GitHub ligado na organização: 409 github_not_connected", async () => {
    await accept("assistant");
    const res = await accept("code_reading");
    expect(res.status).toBe(409);
    expect(errorOf(res)).toBe("github_not_connected");
    expect(await consents()).toHaveLength(1);
  });

  it("code_reading com as duas condições: aceita, com evento próprio", async () => {
    await connectGithub();
    await accept("assistant");
    const res = await accept("code_reading");
    expect(res.status).toBe(200);
    expect(res.body.codeReading).toMatchObject({ inForce: true, version: VERSION, offerable: true });
    expect((await events()).map((e) => e.payload)).toEqual([
      { kind: "assistant", version: VERSION },
      { kind: "code_reading", version: VERSION },
    ]);
  });

  it("duas aceitações simultâneas do mesmo tipo dão uma linha só e nenhum erro", async () => {
    const [a, b] = await Promise.all([accept("assistant"), accept("assistant")]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(await consents()).toHaveLength(1);
    expect(await events()).toHaveLength(1);
  });
});

describe("DELETE /organization/ai-consent/:kind (retirar)", () => {
  it("só o administrador: os demais recebem 403 e o aceite continua", async () => {
    await accept("assistant");
    for (const who of ["teamAdmin", "manager", "contributor", "reader", "plain"] as const) {
      expect((await withdraw("assistant", who)).status, who).toBe(403);
    }
    expect((await state()).body.assistant.inForce).toBe(true);
  });

  it("preenche a retirada da linha em vigor, mantém a linha e grava o evento", async () => {
    await accept("assistant");
    const res = await withdraw("assistant");
    expect(res.status).toBe(200);
    expect(res.body.assistant).toMatchObject({ inForce: false, version: null });
    const [row] = await consents();
    expect(row).toMatchObject({ withdrawn_by_person_id: h.world().people.admin });
    expect(row?.withdrawn_at).toBeInstanceOf(Date);
    expect((await events()).map((e) => [e.kind, e.payload])).toEqual([
      ["organization.ai_consent_accepted", { kind: "assistant", version: VERSION }],
      ["organization.ai_consent_withdrawn", { kind: "assistant", version: VERSION }],
    ]);
  });

  it("depois de retirar dá para aceitar de novo (linha nova)", async () => {
    await accept("assistant");
    await withdraw("assistant");
    await accept("assistant");
    expect(await consents()).toHaveLength(2);
    expect((await state()).body.assistant.inForce).toBe(true);
  });

  it("retirar o que não está em vigor não faz nada e não grava evento", async () => {
    const res = await withdraw("assistant");
    expect(res.status).toBe(200);
    expect(await events()).toHaveLength(0);
  });

  it("retirar o assistente retira também a leitura de código, na mesma operação, com um evento de cada", async () => {
    await connectGithub();
    await accept("assistant");
    await accept("code_reading");
    const res = await withdraw("assistant");
    expect(res.body.assistant.inForce).toBe(false);
    expect(res.body.codeReading.inForce).toBe(false);
    const list = await consents();
    expect(list.every((row) => row.withdrawn_at instanceof Date)).toBe(true);
    expect((await events()).map((e) => [e.kind, (e.payload as { kind: string }).kind]).slice(2)).toEqual([
      ["organization.ai_consent_withdrawn", "assistant"],
      ["organization.ai_consent_withdrawn", "code_reading"],
    ]);
  });

  it("retirar só a leitura de código deixa o assistente", async () => {
    await connectGithub();
    await accept("assistant");
    await accept("code_reading");
    const res = await withdraw("code_reading");
    expect(res.body.assistant.inForce).toBe(true);
    expect(res.body.codeReading.inForce).toBe(false);
  });

  it("retira também o aceite de versão antiga (que não vale, mas ainda está aberto)", async () => {
    await giveConsent(h.pool, "org_A", h.world().people.admin, "assistant", "rascunho-0");
    const res = await withdraw("assistant");
    expect(res.body.assistant).toMatchObject({ inForce: false, version: null, outdated: false });
  });
});

describe("isolamento entre organizações", () => {
  it("o aceite de uma organização não vale para outra e a outra não o altera", async () => {
    const adminB = sessionHeader({ userId: "u_outsider", orgId: "org_B", orgRole: "org:admin" });
    await accept("assistant");
    expect((await h.call("PUT", "/api/organization/ai-consent/assistant", adminB, { version: VERSION })).status).toBe(200);
    expect((await h.call("GET", "/api/organization/ai-consent", adminB)).body.assistant.inForce).toBe(true);
    await h.call("DELETE", "/api/organization/ai-consent/assistant", adminB);
    expect((await state("admin", "org_A")).body.assistant.inForce).toBe(true);
    expect((await h.call("GET", "/api/organization/ai-consent", adminB)).body.assistant.inForce).toBe(false);
    expect(await consents("org_A")).toHaveLength(1);
  });
});

describe("nada grava aceite sozinho", () => {
  it("começar sem aceite, abrir a API e ler /me não cria linha", async () => {
    await h.call("GET", "/api/me", as("admin"));
    await state();
    expect(await rows("select 1 from organization_consents")).toHaveLength(0);
  });
});

describe("/api/me", () => {
  it(`distingue "não configurado", "falta o aceite" e "ligado" (enabled só é verdadeiro com as duas coisas)`, async () => {
    const before = await h.call("GET", "/api/me", as("plain"));
    expect(before.body.assistant).toEqual({ configured: true, consent: false, enabled: false });
    await accept("assistant");
    const after = await h.call("GET", "/api/me", as("plain"));
    expect(after.body.assistant).toEqual({ configured: true, consent: true, enabled: true });
  });

  it("aceite de versão antiga não conta", async () => {
    await giveConsent(h.pool, "org_A", h.world().people.admin, "assistant", "rascunho-0");
    expect((await h.call("GET", "/api/me", as("plain"))).body.assistant.consent).toBe(false);
  });
});
