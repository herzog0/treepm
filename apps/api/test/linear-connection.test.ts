import { Logger } from "@nestjs/common";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialCipher } from "../src/common/credential-cipher.js";
import { LINEAR_CLIENT } from "../src/linear/ports.js";
import type { LinearClient } from "../src/linear/ports.js";
import { LINEAR_KEY_BASE64 } from "./helpers.js";
import { KEY, KEY_B, TEAM_ENG, TEAM_OPS, WORKSPACE, linearWorld, useLinearHarness } from "./linear-support.js";
import { OTHER_ORG, as } from "./world.js";

const { h, put } = useLinearHarness();
const okWorld = () => h.linear().use(linearWorld({ [KEY]: { workspace: WORKSPACE, teams: [TEAM_ENG, TEAM_OPS] }, [KEY_B]: { workspace: { id: "ws-2", name: "Beta", urlKey: "beta" }, teams: [TEAM_ENG] } }));
type Row = Record<string, unknown>;
const rows = async (sql: string, params: unknown[] = []): Promise<Row[]> => (await h.pool.query(sql, params)).rows as Row[];

afterEach(() => vi.restoreAllMocks());

describe("GET /api/linear/connection", () => {
  it("sem credencial: configured true e connection null", async () => {
    const res = await h.call("GET", "/api/linear/connection", as("contributor"));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ configured: true, connection: null });
  });

  it("exige sessão", async () => {
    expect((await request(h.app().getHttpServer()).get("/api/linear/connection")).status).toBe(401);
  });
});

describe("PUT /api/linear/connection", () => {
  it("consulta o Linear (chave sem Bearer), grava cifrado e responde a conexão sem a chave", async () => {
    okWorld();
    const res = await put("contributor");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ configured: true, connection: { workspace: { id: "ws-1", name: "Acme" }, hint: "aaaa" } });
    expect(typeof res.body.connection.connectedAt).toBe("string");
    expect(JSON.stringify(res.body)).not.toContain(KEY);
    expect(h.linear().calls.length).toBeGreaterThan(0);
    for (const call of h.linear().calls) {
      expect(call.headers["authorization"]).toBe(KEY);
      expect(call.url).toBe("https://api.linear.app/graphql");
    }
    const stored = await rows("select * from external_credentials");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ org_id: "org_A", person_id: h.world().people.contributor, provider: "linear", key_version: 1, external_workspace_id: "ws-1", external_workspace_name: "Acme", secret_hint: "aaaa" });
    expect((stored[0]?.["secret_ciphertext"] as Buffer).includes(Buffer.from(KEY))).toBe(false);
    // decifra com a chave de teste e o dado autenticado da linha
    const cipher = new CredentialCipher(Buffer.from(LINEAR_KEY_BASE64, "base64"));
    const plain = cipher.decrypt(
      { ciphertext: stored[0]?.["secret_ciphertext"] as Buffer, nonce: stored[0]?.["secret_nonce"] as Buffer, keyVersion: 1 },
      { orgId: "org_A", personId: h.world().people.contributor, provider: "linear" },
    );
    expect(plain).toBe(KEY);
  });

  it("o GET passa a mostrar a conexão da própria pessoa, e só a dela", async () => {
    okWorld();
    await put("contributor");
    const mine = await h.call("GET", "/api/linear/connection", as("contributor"));
    expect(mine.body.connection).toMatchObject({ workspace: { id: "ws-1", name: "Acme" }, hint: "aaaa" });
    const other = await h.call("GET", "/api/linear/connection", as("reader"));
    expect(other.body).toEqual({ configured: true, connection: null });
  });

  it("substitui a chave da própria pessoa (uma linha só) e troca o workspace e a dica", async () => {
    okWorld();
    await put("contributor");
    const res = await put("contributor", KEY_B);
    expect(res.status).toBe(200);
    expect(res.body.connection).toMatchObject({ workspace: { id: "ws-2", name: "Beta" }, hint: "bbbb" });
    expect(await rows("select secret_hint from external_credentials")).toEqual([{ secret_hint: "bbbb" }]);
  });

  it("chave recusada pelo Linear: 422 linear_key_invalid e nada gravado", async () => {
    okWorld();
    const res = await put("contributor", "lin_api_outra_chave_qualquer");
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe("linear_key_invalid");
    expect(await rows("select 1 from external_credentials")).toHaveLength(0);
  });

  it("Linear fora do ar: 503 linear_unavailable; limite de taxa: 429 com retryAfterSeconds", async () => {
    h.linear().use(linearWorld({ [KEY]: "down", [KEY_B]: "rate" }));
    const down = await put("contributor");
    expect(down.status).toBe(503);
    expect(down.body.error.code).toBe("linear_unavailable");
    const rate = await put("contributor", KEY_B);
    expect(rate.status).toBe(429);
    expect(rate.body.error.code).toBe("linear_rate_limited");
    expect(rate.body.error.details).toEqual({ retryAfterSeconds: 42 });
    expect(await rows("select 1 from external_credentials")).toHaveLength(0);
  });

  it.each([{}, { apiKey: "" }, { apiKey: 5 }, { apiKey: " com espaço" }, { apiKey: "com espaço " }, { apiKey: "x".repeat(201) }, { apiKey: KEY, extra: 1 }])("corpo inválido %j: 400, sem chamar o Linear", async (body) => {
    okWorld();
    const res = await h.call("PUT", "/api/linear/connection", as("contributor"), body);
    expect(res.status).toBe(400);
    expect(h.linear().calls).toHaveLength(0);
  });
});

describe("DELETE /api/linear/connection", () => {
  it("remove só a credencial da própria pessoa", async () => {
    okWorld();
    await put("contributor");
    await put("reader");
    const res = await h.call("DELETE", "/api/linear/connection", as("contributor"));
    expect(res.status).toBe(204);
    expect(await rows("select person_id from external_credentials")).toEqual([{ person_id: h.world().people.reader }]);
    expect((await h.call("GET", "/api/linear/connection", as("contributor"))).body.connection).toBeNull();
  });

  it("sem credencial também responde 204", async () => {
    expect((await h.call("DELETE", "/api/linear/connection", as("contributor"))).status).toBe(204);
  });
});

describe("isolamento entre pessoas e organizações", () => {
  it("A não lê, não usa e não apaga a credencial de B (mesma organização)", async () => {
    okWorld();
    await put("reader");
    // A nunca vê a conexão de B
    expect((await h.call("GET", "/api/linear/connection", as("contributor"))).body.connection).toBeNull();
    // A não usa: sem credencial própria, os times dão 409
    expect((await h.call("GET", "/api/linear/teams", as("contributor"))).status).toBe(409);
    // A não apaga
    await h.call("DELETE", "/api/linear/connection", as("contributor"));
    expect(await rows("select person_id from external_credentials")).toEqual([{ person_id: h.world().people.reader }]);
  });

  it("outra organização não vê nem apaga a credencial desta", async () => {
    okWorld();
    await put("reader");
    const outsider = as("admin", OTHER_ORG);
    expect((await h.call("GET", "/api/linear/connection", outsider)).body.connection).toBeNull();
    await h.call("DELETE", "/api/linear/connection", outsider);
    expect(await rows("select 1 from external_credentials")).toHaveLength(1);
  });

  it("linha de credencial copiada para outra pessoa não decifra (a rota recusa usá-la)", async () => {
    okWorld();
    await put("reader");
    const w = h.world();
    await h.pool.query(
      `insert into external_credentials (org_id, person_id, provider, secret_ciphertext, secret_nonce, key_version, external_workspace_id, external_workspace_name, secret_hint)
       select org_id, $1::uuid, provider, secret_ciphertext, secret_nonce, key_version, external_workspace_id, external_workspace_name, secret_hint from external_credentials where person_id = $2::uuid`,
      [w.people.contributor, w.people.reader],
    );
    h.linear().reset();
    const res = await h.call("GET", "/api/linear/teams", as("contributor"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_not_connected");
    expect(h.linear().calls).toHaveLength(0);
  });
});

describe("dado autenticado inclui a versão da chave", () => {
  it("trocar key_version na linha faz a credencial deixar de decifrar (409 linear_not_connected), sem chamar o Linear", async () => {
    okWorld();
    await put("reader");
    await h.pool.query("update external_credentials set key_version = 2");
    h.linear().reset();
    const res = await h.call("GET", "/api/linear/teams", as("reader"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_not_connected");
    expect(h.linear().calls).toHaveLength(0);
  });
});

describe("a chave nunca vaza", () => {
  const capture = (): string[] => {
    const logged: string[] = [];
    for (const method of ["log", "error", "warn", "debug", "verbose", "fatal"] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => void logged.push(`${method}: ${args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" ")}`));
    }
    return logged;
  };

  it("o logger.error do filtro de erros (500 de verdade) não leva a chave", async () => {
    const logged = capture();
    okWorld();
    await put("contributor");
    const client = h.app().get<LinearClient>(LINEAR_CLIENT);
    vi.spyOn(client, "listTeams").mockRejectedValue(new Error("falha inesperada depois de usar a chave"));
    const res = await h.call("GET", "/api/linear/teams", as("contributor"));
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal_error");
    // prova que o caminho foi o do filtro: a linha de erro está no log, e a chave não
    expect(logged.some((line) => line.startsWith("error:") && line.includes("falha inesperada"))).toBe(true);
    expect(logged.join("\n")).not.toContain(KEY);
    expect(JSON.stringify(res.body)).not.toContain(KEY);
  });

  it("o aviso de credencial ilegível não leva a chave nem o texto cifrado", async () => {
    const logged = capture();
    okWorld();
    await put("contributor");
    const stored = (await rows("select secret_ciphertext from external_credentials"))[0]?.["secret_ciphertext"] as Buffer;
    await h.pool.query("update external_credentials set secret_ciphertext = $1", [Buffer.concat([stored.subarray(0, stored.length - 1), Buffer.from([stored[stored.length - 1]! ^ 1])])]);
    const res = await h.call("GET", "/api/linear/teams", as("contributor"));
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe("linear_not_connected");
    expect(logged.some((line) => line.startsWith("warn:") && line.includes("ilegível"))).toBe(true);
    const everything = logged.join("\n") + JSON.stringify(res.body);
    expect(everything).not.toContain(KEY);
    expect(everything).not.toContain(stored.toString("base64"));
    expect(everything).not.toContain(stored.toString("hex"));
  });

  it("não aparece em nenhuma resposta nem em nenhum log, nem nas falhas", async () => {
    const logged: string[] = [];
    for (const method of ["log", "error", "warn", "debug", "verbose", "fatal"] as const) {
      vi.spyOn(Logger.prototype, method).mockImplementation((...args: unknown[]) => void logged.push(args.map((a) => (a instanceof Error ? `${a.message} ${a.stack}` : String(a))).join(" ")));
    }
    for (const stream of [process.stdout, process.stderr]) {
      vi.spyOn(stream, "write").mockImplementation(((chunk: unknown) => (logged.push(String(chunk)), true)) as typeof process.stdout.write);
    }
    okWorld();
    const responses = [
      await put("contributor"),
      await h.call("GET", "/api/linear/connection", as("contributor")),
      await h.call("GET", "/api/linear/teams", as("contributor")),
      await put("contributor", "lin_api_chave_recusada_zzzz"),
    ];
    h.linear().use(linearWorld({ [KEY]: "down" }));
    responses.push(await h.call("GET", "/api/linear/teams", as("contributor")));
    h.linear().use(linearWorld({ [KEY]: "invalid" }));
    responses.push(await h.call("GET", "/api/linear/teams", as("contributor")));
    responses.push(await h.call("DELETE", "/api/linear/connection", as("contributor")));
    const everything = JSON.stringify(responses.map((r) => [r.status, r.body, r.headers])) + logged.join("\n");
    for (const secret of [KEY, "SEGREDO", "lin_api_chave_recusada_zzzz", LINEAR_KEY_BASE64]) expect(everything).not.toContain(secret);
  });
});
