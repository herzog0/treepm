import { describe, expect, it } from "vitest";
import { AccessTokenService } from "../src/access-tokens/access-token.service.js";
import type { ResolveResult } from "../src/access-tokens/access-token.service.js";
import { buildToken, parseToken } from "../src/access-tokens/token.js";
import { MINUTE, DAY, useTokenHarness } from "./access-token-support.js";
import { ORG, OTHER_ORG, as } from "./world.js";
import type { Who } from "./world.js";

const h = useTokenHarness();

const service = () => h.app().get(AccessTokenService);
const resolve = (token: string, key = "PRIV"): Promise<ResolveResult> => service().resolve(token, key);

/** Liga a chave, cria um token pela API e devolve o token inteiro e o id. */
async function issue(who: Who, project: "priv" | "org" = "priv", orgId = ORG): Promise<{ token: string; id: string }> {
  await h.enableMcp(orgId);
  const projectId = h.world().projects[project];
  const res = await h.create(who, projectId);
  expect(res.status).toBe(201);
  return { token: res.body.token as string, id: res.body.id as string };
}

async function failure(token: string, key = "PRIV"): Promise<string> {
  const result = await resolve(token, key);
  return result.ok ? "ok" : result.reason;
}

const personActive = async (clerkUserId: string): Promise<boolean> =>
  (await h.pool.query<{ active: boolean }>("select active from people where org_id = $1 and clerk_user_id = $2", [ORG, clerkUserId])).rows[0]
    ?.active ?? false;

const lastUsed = async (id: string): Promise<{ at: Date | null; updated: Date }> => {
  const row = (await h.pool.query<{ last_used_at: Date | null; updated_at: Date }>("select last_used_at, updated_at from access_tokens where id = $1", [id])).rows[0];
  return { at: row?.last_used_at ?? null, updated: row?.updated_at ?? new Date(0) };
};

describe("resolver: caminho feliz", () => {
  it("devolve o mesmo Principal da sessão, mais o projeto", async () => {
    const { token, id } = await issue("contributor");
    const result = await resolve(token);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tokenId).toBe(id);
    expect(result.project).toMatchObject({ id: h.world().projects.priv, key: "PRIV", name: "Privado" });
    expect(result.principal.person).toMatchObject({ id: h.world().people.contributor, clerkRole: "member" });
    expect(result.principal.organization).toMatchObject({ orgId: ORG, mcpEnabled: true });
    expect(result.principal.session).toMatchObject({ userId: "u_contributor", orgId: ORG, orgRole: "org:member" });
    expect(result.principal.actor.clerkRole).toBe("member");
    expect(result.principal.actor.projectRoles.get(h.world().projects.priv)).toBe("contributor");
    // O mesmo que a sessão produz pela rota /api/me.
    const me = await h.call("GET", "/api/me", as("contributor"));
    expect(me.body.roles.projects).toEqual([...result.principal.actor.projectRoles].map(([projectId, role]) => ({ projectId, role })));
  });

  it("projeto arquivado pode ser lido", async () => {
    const { token } = await issue("contributor");
    await h.pool.query("update projects set archived_at = now() where id = $1", [h.world().projects.priv]);
    expect(await failure(token)).toBe("ok");
  });
});

describe("resolver: falhas", () => {
  it("token malformado → invalid", async () => {
    expect(await failure("")).toBe("invalid");
    expect(await failure("tpm_xx")).toBe("invalid");
    expect(await failure("Bearer abc")).toBe("invalid");
  });

  it("token bem formado mas desconhecido → invalid", async () => {
    await h.enableMcp();
    expect(await failure(buildToken(ORG).token)).toBe("invalid");
  });

  it("revogado → invalid; vencido → invalid", async () => {
    const revoked = await issue("contributor");
    await h.call("DELETE", `/api/access-tokens/${revoked.id}`, as("contributor"));
    expect(await failure(revoked.token)).toBe("invalid");

    const expiring = await issue("manager");
    expect(await failure(expiring.token)).toBe("ok");
    h.clock.advance(90 * DAY + MINUTE);
    expect(await failure(expiring.token)).toBe("invalid");
  });

  it("chave da organização desligada → disabled; ligada de novo, o mesmo token volta a valer", async () => {
    const { token } = await issue("contributor");
    await h.enableMcp(ORG, false);
    expect(await failure(token)).toBe("disabled");
    await h.enableMcp(ORG, true);
    expect(await failure(token)).toBe("ok");
  });

  it("pessoa inativa no banco → invalid, sem consultar o Clerk", async () => {
    const { token } = await issue("contributor");
    await h.pool.query("update people set active = false where id = $1", [h.world().people.contributor]);
    expect(await failure(token)).toBe("invalid");
    expect(h.directory().calls.memberships).toHaveLength(0);
  });

  it("papel de organização fora de admin/member no Clerk → invalid", async () => {
    const { token } = await issue("contributor");
    h.directory().memberships.set(`${ORG}:u_contributor`, "org:billing");
    expect(await failure(token)).toBe("invalid");
  });

  it("chave de projeto errada, inexistente ou de outro projeto → not_found", async () => {
    const { token } = await issue("contributor");
    expect(await failure(token, "OPEN")).toBe("not_found");
    expect(await failure(token, "NOPE")).toBe("not_found");
    expect(await failure(token, "priv")).toBe("not_found");
  });

  it("a pessoa que perde o acesso ao projeto falha na chamada seguinte", async () => {
    const { token } = await issue("contributor");
    expect(await failure(token)).toBe("ok");
    await h.pool.query("delete from project_memberships where person_id = $1 and project_id = $2", [h.world().people.contributor, h.world().projects.priv]);
    expect(await failure(token)).toBe("not_found");
  });

  it("projeto removido: o token some junto → invalid", async () => {
    const { token } = await issue("contributor");
    await h.pool.query("delete from projects where id = $1", [h.world().projects.priv]);
    expect(await failure(token)).toBe("invalid");
  });
});

describe("resolver: isolamento entre organizações", () => {
  it("token de uma organização nunca resolve na outra", async () => {
    const { token } = await issue("contributor");
    const secret = parseToken(token)?.secret ?? "";
    const asOther = `tpm_${Buffer.from(OTHER_ORG).toString("base64url")}_${secret}`;
    expect(await failure(asOther)).toBe("invalid");
    // E o mesmo token só enxerga o projeto da própria organização, mesmo com a chave repetida em B.
    const result = await resolve(token, "PRIV");
    expect(result.ok && result.project.id).toBe(h.world().projects.priv);
    expect(result.ok && result.project.id).not.toBe(h.world().other.project);
  });

  it("referência de organização que não existe só faz o token não ser achado", async () => {
    const forged = buildToken("org_INEXISTENTE").token;
    expect(await failure(forged)).toBe("invalid");
  });

  it("revogar na organização A não afeta tokens da B", async () => {
    const a = await issue("contributor");
    await h.enableMcp(OTHER_ORG);
    const bProject = (await h.call("POST", "/api/projects", as("admin", OTHER_ORG), { name: "Beta", key: "BETA" })).body.id as string;
    const bToken = (await h.call("POST", "/api/access-tokens", as("admin", OTHER_ORG), { projectId: bProject, name: "b" })).body.token as string;
    await h.call("DELETE", `/api/access-tokens/${a.id}`, as("admin"));
    expect(await failure(a.token)).toBe("invalid");
    expect(await failure(bToken, "BETA")).toBe("ok");
  });
});

describe("resolver: participação no Clerk", () => {
  it("confere a participação com a organização e a pessoa certas e guarda por 5 minutos", async () => {
    const { token } = await issue("contributor");
    await resolve(token);
    await resolve(token);
    h.clock.advance(4 * MINUTE + 59_000);
    await resolve(token);
    expect(h.directory().calls.memberships).toEqual([{ orgId: ORG, userId: "u_contributor" }]);
    h.clock.advance(2_000);
    await resolve(token);
    expect(h.directory().calls.memberships).toHaveLength(2);
  });

  it("a pessoa que sai da organização ainda passa dentro dos 5 minutos e falha depois, ficando inativa", async () => {
    const { token } = await issue("contributor");
    expect(await failure(token)).toBe("ok");
    h.directory().memberships.set(`${ORG}:u_contributor`, null);
    h.clock.advance(4 * MINUTE);
    expect(await failure(token)).toBe("ok");
    h.clock.advance(MINUTE + 1);
    expect(await failure(token)).toBe("invalid");
    expect(await personActive("u_contributor")).toBe(false);
    // Daí em diante a recusa vem do banco, sem nova ida ao Clerk.
    const calls = h.directory().calls.memberships.length;
    expect(await failure(token)).toBe("invalid");
    expect(h.directory().calls.memberships).toHaveLength(calls);
  });

  it("mudança de papel no Clerk reflete depois da memória (promoção)", async () => {
    const { token } = await issue("contributor");
    const before = await resolve(token);
    expect(before.ok && before.principal.actor.clerkRole).toBe("member");
    h.directory().memberships.set(`${ORG}:u_contributor`, "org:admin");
    const cached = await resolve(token);
    expect(cached.ok && cached.principal.actor.clerkRole).toBe("member");
    h.clock.advance(5 * MINUTE + 1);
    const after = await resolve(token);
    expect(after.ok && after.principal.actor.clerkRole).toBe("admin");
    expect(after.ok && after.principal.person.clerkRole).toBe("admin");
  });

  it("rebaixamento: o administrador vira membro, sem papel no projeto privado, e perde o acesso", async () => {
    const { token } = await issue("admin");
    expect(await failure(token)).toBe("ok");
    h.directory().memberships.set(`${ORG}:u_admin`, "org:member");
    expect(await failure(token)).toBe("ok");
    h.clock.advance(5 * MINUTE + 1);
    expect(await failure(token)).toBe("not_found");
  });

  it("a chamada ao Clerk nunca acontece com transação aberta", async () => {
    const { token } = await issue("contributor");
    const observed: number[] = [];
    h.directory().onCall = async () => {
      const r = await h.pool.query<{ n: string }>(
        "select count(*)::text as n from pg_stat_activity where usename = 'treepm_app' and datname = current_database() and state like 'idle in transaction%'",
      );
      observed.push(Number(r.rows[0]?.n));
    };
    expect(await failure(token)).toBe("ok");
    expect(observed).toEqual([0]);
  });

  it("falha do Clerk não deixa passar: o erro sobe e nada é marcado", async () => {
    const { token } = await issue("contributor");
    h.directory().onCall = () => Promise.reject(new Error("Clerk fora do ar"));
    await expect(resolve(token)).rejects.toThrow("Clerk fora do ar");
    expect(await personActive("u_contributor")).toBe(true);
  });
});

describe("resolver: último uso", () => {
  it("grava no primeiro uso e não regrava dentro de 5 minutos", async () => {
    const { token, id } = await issue("contributor");
    expect((await lastUsed(id)).at).toBeNull();
    await resolve(token);
    const first = await lastUsed(id);
    expect(first.at).toBeInstanceOf(Date);
    h.clock.advance(4 * MINUTE + 59_000);
    await resolve(token);
    expect(await lastUsed(id)).toEqual(first);
  });

  it("regrava passados 5 minutos", async () => {
    const { token, id } = await issue("contributor");
    await resolve(token);
    const first = await lastUsed(id);
    h.clock.advance(5 * MINUTE + 1);
    await resolve(token);
    const second = await lastUsed(id);
    expect(second.at?.getTime()).toBeGreaterThan(first.at?.getTime() ?? 0);
  });

  it("chamada que falha não conta como uso", async () => {
    const { token, id } = await issue("contributor");
    await resolve(token, "OPEN");
    expect((await lastUsed(id)).at).toBeNull();
  });
});

describe("resolver: limite de requisições", () => {
  it("60 por minuto por token; a 61ª é rate_limited e depois de um minuto volta", async () => {
    const a = await issue("contributor");
    const b = await issue("manager");
    for (let i = 0; i < 60; i++) expect(await failure(a.token), `chamada ${i + 1}`).toBe("ok");
    const blocked = await resolve(a.token);
    expect(blocked.ok).toBe(false);
    expect(!blocked.ok && blocked.reason).toBe("rate_limited");
    expect(await failure(b.token)).toBe("ok");
    h.clock.advance(MINUTE + 1);
    expect(await failure(a.token)).toBe("ok");
  });

  it("chamadas dentro da janela deslizante contam, as antigas saem", async () => {
    const { token } = await issue("contributor");
    for (let i = 0; i < 30; i++) await resolve(token);
    h.clock.advance(40_000);
    for (let i = 0; i < 30; i++) await resolve(token);
    expect(await failure(token)).toBe("rate_limited");
    h.clock.advance(21_000); // as 30 primeiras já passaram de 60 s
    for (let i = 0; i < 30; i++) expect(await failure(token)).toBe("ok");
    expect(await failure(token)).toBe("rate_limited");
  });

  it("token inválido não gasta cota de ninguém", async () => {
    const a = await issue("contributor");
    for (let i = 0; i < 100; i++) await resolve(buildToken(ORG).token);
    expect(await failure(a.token)).toBe("ok");
  });
});


describe("resolver: entrada hostil nunca vira exceção", () => {
  it("token com byte nulo, controle, referência enorme ou token enorme → invalid", async () => {
    const secret = buildToken(ORG).secret;
    const ref = (orgId: string) => Buffer.from(orgId).toString("base64url");
    const hostile = [
      `tpm_AA_${"A".repeat(43)}`,
      `tpm_${ref("org\u0000A")}_${secret}`,
      `tpm_${ref("org\u001fA")}_${secret}`,
      `tpm_${ref("x".repeat(100_000))}_${secret}`,
      `tpm_${"A".repeat(2_000_000)}`,
      "\u0000",
    ];
    for (const raw of hostile) expect(await failure(raw)).toBe("invalid");
  });

  it("projectKey fora do formato de chave de projeto → not_found, sem ir ao banco", async () => {
    const { token } = await issue("contributor");
    for (const key of ["PR\u0000IV", "", "P", "priv", "PRIV ", "X".repeat(11), "PRIV'--", "1PRIV", "x".repeat(100_000)]) {
      expect(await failure(token, key), JSON.stringify(key.slice(0, 20))).toBe("not_found");
    }
    expect(await failure(token, "PRIV")).toBe("ok");
  });
});

describe("resolver: quem sai e volta não ressuscita tokens", () => {
  it("ao detectar a saída, revoga todos os tokens ativos da pessoa, com evento automático de cada um", async () => {
    const a = await issue("contributor");
    const b = await h.create("contributor", h.world().projects.priv, { name: "segundo" });
    const other = await h.create("manager", h.world().projects.priv, { name: "de outra pessoa" });
    expect(await failure(a.token)).toBe("ok");
    h.directory().memberships.set(`${ORG}:u_contributor`, null);
    h.clock.advance(5 * MINUTE + 1);
    expect(await failure(a.token)).toBe("invalid");

    const rows = (await h.pool.query<{ id: string; revoked_at: Date | null }>("select id, revoked_at from access_tokens")).rows;
    const revoked = new Set(rows.filter((row) => row.revoked_at).map((row) => row.id));
    expect(revoked).toEqual(new Set([a.id, b.body.id]));
    expect(revoked.has(other.body.id)).toBe(false);
    const events = (await h.pool.query<{ payload: Record<string, unknown>; actor_person_id: string | null }>(
      "select payload, actor_person_id from activity_events where kind = 'access_token.revoked'",
    )).rows;
    expect(events).toHaveLength(2);
    for (const event of events) expect(event.payload).toMatchObject({ automatic: true, reason: "left_organization", projectKey: "PRIV" });
    expect(events.map((event) => event.payload["tokenId"]).sort()).toEqual([a.id, b.body.id].sort());
  });

  it("sai, volta (a sessão reativa a pessoa) e o token antigo continua invalid", async () => {
    const { token } = await issue("contributor");
    expect(await failure(token)).toBe("ok");
    h.directory().memberships.set(`${ORG}:u_contributor`, null);
    h.clock.advance(5 * MINUTE + 1);
    expect(await failure(token)).toBe("invalid");
    h.directory().memberships.delete(`${ORG}:u_contributor`);
    expect((await h.call("GET", "/api/me", as("contributor"))).status).toBe(200);
    expect(await personActive("u_contributor")).toBe(true);
    h.clock.advance(6 * MINUTE);
    expect(await failure(token)).toBe("invalid");
    // Um token novo, criado depois da volta, vale.
    const fresh = (await h.create("contributor", h.world().projects.priv, { name: "novo" })).body.token as string;
    expect(await failure(fresh)).toBe("ok");
  });
});

describe("resolver: reconferência depois da chamada ao Clerk", () => {
  it("token revogado durante a chamada ao Clerk → invalid", async () => {
    const { token, id } = await issue("contributor");
    h.directory().onCall = async () => {
      await h.pool.query("update access_tokens set revoked_at = now() where id = $1", [id]);
    };
    expect(await failure(token)).toBe("invalid");
    expect((await lastUsed(id)).at).toBeNull();
  });

  it("token vencido durante a chamada ao Clerk → invalid", async () => {
    const { token } = await issue("contributor");
    h.directory().onCall = () => {
      h.clock.advance(91 * DAY);
      return Promise.resolve();
    };
    expect(await failure(token)).toBe("invalid");
  });

  it("chave da organização desligada durante a chamada ao Clerk → disabled", async () => {
    const { token } = await issue("contributor");
    h.directory().onCall = async () => {
      await h.enableMcp(ORG, false);
    };
    expect(await failure(token)).toBe("disabled");
  });

  it("pessoa desativada durante a chamada ao Clerk → invalid", async () => {
    const { token } = await issue("contributor");
    h.directory().onCall = async () => {
      await h.pool.query("update people set active = false where id = $1", [h.world().people.contributor]);
    };
    expect(await failure(token)).toBe("invalid");
  });
});

describe("resolver: uma chamada ao Clerk por vez por pessoa", () => {
  it("requisições simultâneas com a memória fria compartilham a mesma chamada", async () => {
    const { token } = await issue("contributor");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    h.directory().onCall = () => gate;
    const pending = Array.from({ length: 6 }, () => resolve(token));
    await new Promise((done) => setTimeout(done, 1000));
    release();
    const results = await Promise.all(pending);
    expect(results.every((result) => result.ok)).toBe(true);
    expect(h.directory().calls.memberships).toHaveLength(1);
  });

  it("chamada que falha não fica guardada: todas as que esperavam falham e a seguinte tenta de novo", async () => {
    const { token } = await issue("contributor");
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    h.directory().onCall = async () => {
      await gate;
      throw new Error("Clerk fora do ar");
    };
    const pending = Array.from({ length: 3 }, () => resolve(token).then(() => "resolveu", (error: Error) => error.message));
    await new Promise((done) => setTimeout(done, 1000));
    release();
    expect(await Promise.all(pending)).toEqual(["Clerk fora do ar", "Clerk fora do ar", "Clerk fora do ar"]);
    expect(h.directory().calls.memberships).toHaveLength(1);
    h.directory().onCall = null;
    expect(await failure(token)).toBe("ok");
    expect(h.directory().calls.memberships).toHaveLength(2);
  });

  it("pessoas diferentes não compartilham a chamada", async () => {
    const a = await issue("contributor");
    const b = await h.create("manager", h.world().projects.priv);
    await Promise.all([resolve(a.token), resolve(b.body.token as string)]);
    expect(h.directory().calls.memberships.map((call) => call.userId).sort()).toEqual(["u_contributor", "u_manager"]);
  });
});

describe("projeto arquivado e token novo", () => {
  it("pode receber token novo (e ele lê)", async () => {
    await h.enableMcp();
    await h.pool.query("update projects set archived_at = now() where id = $1", [h.world().projects.priv]);
    const created = await h.create("contributor", h.world().projects.priv);
    expect(created.status).toBe(201);
    expect(await failure(created.body.token as string)).toBe("ok");
  });
});
