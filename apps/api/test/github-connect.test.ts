import { describe, expect, it } from "vitest";
import { signState } from "../src/github/state.js";
import { GITHUB_CONFIG, GITHUB_SECRETS } from "./helpers.js";
import { useHarness } from "./harness.js";
import { as } from "./world.js";
import type { Who } from "./world.js";

const h = useHarness(GITHUB_CONFIG);

const SECRET = GITHUB_SECRETS.clientSecret;
const outsider = JSON.stringify({ userId: "u_outsider", orgId: "org_B", orgRole: "org:admin", sessionStatus: "active" });

/** Pede o `state` à API como a pessoa e o devolve como veio na URL de instalação. */
async function mintState(who: Who | "outsider"): Promise<string> {
  const res = await h.call("POST", "/api/github/connect", who === "outsider" ? outsider : as(who));
  expect(res.status).toBe(200);
  const url = new URL(res.body.url as string);
  return url.searchParams.get("state") ?? "";
}

const signFor = (orgId: string, userId: string, at: Date = new Date()) => signState(SECRET, { orgId, userId }, at);

async function complete(who: Who | "outsider", body: Record<string, unknown>) {
  return h.call("POST", "/api/github/connect/complete", who === "outsider" ? outsider : as(who), body);
}

/** As chamadas ao provedor, sem a montagem da URL de instalação que `mintState` provoca. */
const providerCalls = () => h.github().calls.filter((call) => call !== "installUrl");

async function rows(sql: string, params: unknown[] = []) {
  return (await h.pool.query(sql, params)).rows as Record<string, unknown>[];
}

describe("POST /api/github/connect", () => {
  it("o administrador recebe a URL de instalação com um state que só vale para ele", async () => {
    const res = await h.call("POST", "/api/github/connect", as("admin"));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["url"]);
    const url = new URL(res.body.url as string);
    expect(url.origin + url.pathname).toBe("https://github.com/apps/treepm-dev/installations/new");
    const state = url.searchParams.get("state") ?? "";
    expect(state.length).toBeGreaterThan(20);
    expect(state).not.toContain(SECRET);
    expect(h.github().calls).toEqual(["installUrl"]);
  });

  it.each(["teamAdmin", "manager", "contributor", "reader", "plain"] as const)("%s não conecta (403)", async (who) => {
    const res = await h.call("POST", "/api/github/connect", as(who));
    expect(res.status).toBe(403);
    expect(h.github().calls).toEqual([]);
  });

  it("sem sessão, 401", async () => {
    const res = await h.call("POST", "/api/github/connect", "{}");
    expect([401, 403]).toContain(res.status);
  });
});

describe("POST /api/github/connect/complete — o caminho feliz", () => {
  it("grava a instalação, responde sem o identificador do GitHub e registra github.connected", async () => {
    h.github().scenario();
    const state = await mintState("admin");
    const res = await complete("admin", { code: "good-code", state });
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      installation: { accountLogin: "herzog0", accountType: "User", repositorySelection: "selected", connectedAt: expect.any(String) },
    });
    expect(JSON.stringify(res.body)).not.toContain("101");
    const saved = await rows("select * from github_installations");
    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatchObject({ org_id: "org_A", account_login: "herzog0", account_type: "User", repository_selection: "selected", connected_by_person_id: h.world().people.admin });
    expect(String(saved[0]?.["installation_id"])).toBe("101");
    const events = await rows("select kind, subject_type, subject_id, actor_person_id, payload from activity_events where kind like 'github.%'");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "github.connected", actor_person_id: h.world().people.admin });
    expect(providerCalls()).toEqual(["exchangeCode:good-code", "getInstallation:101"]);
  });

  it("com installationId na lista do usuário, usa esse", async () => {
    h.github().scenario();
    const res = await complete("admin", { code: "good-code", state: await mintState("admin"), installationId: 101 });
    expect(res.status).toBe(201);
  });

  it("o login do usuário do token e o da conta pessoal comparam sem diferenciar maiúsculas", async () => {
    h.github().scenario({ userLogin: "HerZog0" });
    const res = await complete("admin", { code: "good-code", state: await mintState("admin") });
    expect(res.status).toBe(201);
  });

  it("a conta vem de getInstallation, não da lista do usuário", async () => {
    h.github().scenario();
    h.github().codes.set("good-code", { userLogin: "herzog0", installations: [{ installationId: 101, accountLogin: "mentira", accountType: "Organization" }] });
    const res = await complete("admin", { code: "good-code", state: await mintState("admin") });
    expect(res.status).toBe(201);
    expect(res.body.installation.accountLogin).toBe("herzog0");
  });
});

describe("POST /api/github/connect/complete — o state", () => {
  it("lixo, adulterado e assinado com outro segredo: 400 invalid_state, sem tocar no GitHub", async () => {
    h.github().scenario();
    const good = await mintState("admin");
    const [payload = "", signature = ""] = good.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(payload, "base64url").toString()), orgId: "org_B" })).toString("base64url");
    const others = [
      "lixo",
      `${payload}.${signature.slice(0, -2)}xx`,
      `${forged}.${signature}`,
      signState("outro-segredo-qualquer-1234", { orgId: "org_A", userId: "u_admin" }, new Date()),
    ];
    for (const state of others) {
      const res = await complete("admin", { code: "good-code", state });
      expect(res.status, state).toBe(400);
      expect(res.body.error.code).toBe("invalid_state");
    }
    expect(h.github().calls.filter((call) => call.startsWith("exchangeCode"))).toEqual([]);
    expect(await rows("select 1 from github_installations")).toHaveLength(0);
  });

  it("vencido (mais de 10 minutos): 400 invalid_state", async () => {
    h.github().scenario();
    const res = await complete("admin", { code: "good-code", state: signFor("org_A", "u_admin", new Date(Date.now() - 11 * 60_000)) });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_state");
  });

  it("de outra organização ou de outro usuário: 400 invalid_state", async () => {
    h.github().scenario();
    const otherOrg = await complete("admin", { code: "good-code", state: await mintState("outsider") });
    expect(otherOrg.status).toBe(400);
    expect(otherOrg.body.error.code).toBe("invalid_state");
    const otherUser = await complete("admin", { code: "good-code", state: signFor("org_A", "u_outro_usuario") });
    expect(otherUser.status).toBe(400);
    expect(otherUser.body.error.code).toBe("invalid_state");
    expect(await rows("select 1 from github_installations")).toHaveLength(0);
  });

  it("o state é conferido antes do papel: quem não é administrador com state ruim recebe 400; com state bom, 403 sem chamar o GitHub", async () => {
    h.github().scenario();
    const bad = await complete("plain", { code: "good-code", state: "lixo" });
    expect(bad.status).toBe(400);
    const good = await complete("plain", { code: "good-code", state: signFor("org_A", "u_plain") });
    expect(good.status).toBe(403);
    expect(providerCalls()).toEqual([]);
    expect(await rows("select 1 from github_installations")).toHaveLength(0);
  });

  it("corpo malformado: 400 validation_error", async () => {
    for (const body of [{}, { code: "x" }, { state: "x" }, { code: "", state: "x" }, { code: "x", state: "y", installationId: "101" }, { code: "x", state: "y", installationId: -1 }, { code: "x", state: "y", extra: 1 }]) {
      const res = await complete("admin", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body.error.code).toBe("validation_error");
    }
  });
});

describe("POST /api/github/connect/complete — o código e a escolha da instalação", () => {
  it("código recusado pelo GitHub: 400 invalid_code, nada gravado", async () => {
    const res = await complete("admin", { code: "velho", state: await mintState("admin") });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("invalid_code");
    expect(await rows("select 1 from github_installations")).toHaveLength(0);
  });

  it("installationId fora da lista do usuário: 403 installation_not_yours, sem consultar a instalação", async () => {
    h.github().scenario();
    const res = await complete("admin", { code: "good-code", state: await mintState("admin"), installationId: 999 });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("installation_not_yours");
    expect(providerCalls()).toEqual(["exchangeCode:good-code"]);
    expect(await rows("select 1 from github_installations")).toHaveLength(0);
  });

  it("sem installationId e sem instalações na lista: 409 no_installation", async () => {
    h.github().codes.set("good-code", { userLogin: "herzog0", installations: [] });
    const res = await complete("admin", { code: "good-code", state: await mintState("admin") });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("no_installation");
  });

  it("sem installationId e com mais de uma na lista: 409 installation_ambiguous; com o id, vale", async () => {
    h.github().scenario();
    h.github().codes.set("good-code", {
      userLogin: "herzog0",
      installations: [
        { installationId: 101, accountLogin: "herzog0", accountType: "User" },
        { installationId: 102, accountLogin: "herzog0", accountType: "User" },
      ],
    });
    const ambiguous = await complete("admin", { code: "good-code", state: await mintState("admin") });
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.error.code).toBe("installation_ambiguous");
    const chosen = await complete("admin", { code: "good-code", state: await mintState("admin"), installationId: 101 });
    expect(chosen.status).toBe(201);
  });

  it("instalação inexistente, de outro app ou suspensa: 409 installation_unavailable", async () => {
    for (const setup of [
      () => h.github().installations.delete(101),
      () => h.github().installations.set(101, { ...h.github().installations.get(101)!, appId: 1 }),
      () => h.github().installations.set(101, { ...h.github().installations.get(101)!, suspended: true }),
    ]) {
      h.github().reset();
      h.github().scenario();
      setup();
      const res = await complete("admin", { code: "good-code", state: await mintState("admin") });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe("installation_unavailable");
      expect(await rows("select 1 from github_installations")).toHaveLength(0);
    }
  });
});

describe("POST /api/github/connect/complete — acesso não é posse", () => {
  it("conta pessoal de outra pessoa (o usuário tem acesso, mas o login é outro): 403 installation_not_yours", async () => {
    h.github().scenario({ userLogin: "mallory", accountLogin: "herzog0" });
    const res = await complete("admin", { code: "good-code", state: await mintState("admin") });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("installation_not_yours");
    expect(await rows("select 1 from github_installations")).toHaveLength(0);
  });

  it("conta de organização (ou de outro tipo): 409 organization_account_unsupported, nada gravado", async () => {
    for (const accountType of ["Organization", "Enterprise", "Bot"]) {
      h.github().reset();
      h.github().scenario({ accountType, accountLogin: "acme", userLogin: "acme" });
      const res = await complete("admin", { code: "good-code", state: await mintState("admin") });
      expect(res.status, accountType).toBe(409);
      expect(res.body.error.code).toBe("organization_account_unsupported");
      expect(await rows("select 1 from github_installations")).toHaveLength(0);
    }
  });

  it("o tipo vem de getInstallation: a lista dizendo User não basta", async () => {
    h.github().scenario();
    h.github().installations.set(101, { ...h.github().installations.get(101)!, accountType: "Organization" });
    const res = await complete("admin", { code: "good-code", state: await mintState("admin") });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("organization_account_unsupported");
  });
});

describe("POST /api/github/connect/complete — um para um", () => {
  it("a organização que já tem instalação: 409 already_connected", async () => {
    h.github().scenario();
    expect((await complete("admin", { code: "good-code", state: await mintState("admin") })).status).toBe(201);
    h.github().scenario({ installationId: 202 });
    const second = await complete("admin", { code: "good-code", state: await mintState("admin") });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe("already_connected");
    expect(await rows("select 1 from github_installations")).toHaveLength(1);
  });

  it("instalação já presa a outra organização: 409 installation_in_use, sem revelar qual", async () => {
    h.github().scenario();
    expect((await complete("admin", { code: "good-code", state: await mintState("admin") })).status).toBe(201);
    const res = await complete("outsider", { code: "good-code", state: await mintState("outsider") });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("installation_in_use");
    expect(JSON.stringify(res.body)).not.toMatch(/org_A|org_B/);
    expect(await rows("select org_id from github_installations")).toEqual([{ org_id: "org_A" }]);
    // a recusa não deixa transação suja: a organização B continua livre para outra instalação
    h.github().scenario({ installationId: 303 });
    const other = await complete("outsider", { code: "good-code", state: await mintState("outsider") });
    expect(other.status).toBe(201);
  });
});

describe("POST /api/github/connect/complete — o provedor falha", () => {
  it.each(["exchangeCode", "getInstallation"] as const)("falha em %s: 503 github_unavailable, nada gravado", async (operation) => {
    h.github().scenario();
    h.github().failOn = operation;
    const res = await complete("admin", { code: "good-code", state: await mintState("admin") });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("github_unavailable");
    expect(await rows("select 1 from github_installations")).toHaveLength(0);
  });

  it("erro inesperado do provedor (corpo do GitHub na mensagem) também é 503, e a mensagem não vaza", async () => {
    h.github().scenario();
    h.github().fail = true;
    h.github().failWith = new Error("corpo do GitHub: SENTINELA-corpo-da-resposta");
    const res = await complete("admin", { code: "good-code", state: await mintState("admin") });
    expect(res.status).toBe(503);
    expect(res.body.error.code).toBe("github_unavailable");
    expect(JSON.stringify(res.body)).not.toContain("SENTINELA");
  });
});
