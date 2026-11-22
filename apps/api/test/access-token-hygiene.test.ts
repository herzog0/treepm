import { Logger } from "@nestjs/common";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AccessTokenService } from "../src/access-tokens/access-token.service.js";
import { hashToken, parseToken } from "../src/access-tokens/token.js";
import { MINUTE, useTokenHarness } from "./access-token-support.js";
import { as } from "./world.js";

const h = useTokenHarness();

const captured: string[] = [];
const spies: { mockRestore(): void }[] = [];

beforeEach(() => {
  captured.length = 0;
  const grab = (...args: unknown[]): void => {
    captured.push(args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack ?? ""}` : typeof arg === "string" ? arg : JSON.stringify(arg))).join(" "));
  };
  for (const method of ["log", "warn", "error", "debug", "verbose", "fatal"] as const) {
    spies.push(vi.spyOn(Logger.prototype, method).mockImplementation(grab));
    spies.push(vi.spyOn(Logger, method).mockImplementation(grab));
  }
  for (const method of ["log", "warn", "error", "info", "debug"] as const) spies.push(vi.spyOn(console, method).mockImplementation(grab));
});
afterEach(() => {
  while (spies.length) spies.pop()?.mockRestore();
});

describe("higiene: o token e o resumo nunca vazam", () => {
  it("criar, usar, falhar e revogar não deixam o token nem o resumo em log, evento, erro ou listagem", async () => {
    await h.enableMcp();
    const created = await h.create("contributor", h.world().projects.priv, { name: "Notebook" });
    expect(created.status).toBe(201);
    const token = created.body.token as string;
    const secret = parseToken(token)?.secret ?? "";
    const hash = hashToken(token);
    const service = h.app().get(AccessTokenService);

    const bodies: unknown[] = [];
    const used = await service.resolve(token, "PRIV");
    expect(used.ok).toBe(true);
    // Falhas de vários tipos.
    expect((await service.resolve(token, "OPEN")).ok).toBe(false);
    h.directory().memberships.set("org_A:u_contributor", "org:billing");
    h.clock.advance(6 * MINUTE);
    expect((await service.resolve(token, "PRIV")).ok).toBe(false);
    h.directory().memberships.delete("org_A:u_contributor");
    await h.pool.query("update people set active = true where id = $1", [h.world().people.contributor]);
    await h.enableMcp("org_A", false);
    expect((await service.resolve(token, "PRIV")).ok).toBe(false);
    await h.enableMcp("org_A", true);
    for (let i = 0; i < 61; i++) await service.resolve(token, "PRIV");
    expect((await service.resolve("tpm_lixo", "PRIV")).ok).toBe(false);

    // Respostas HTTP, inclusive de erro, e listagens.
    bodies.push((await h.call("GET", "/api/access-tokens", as("contributor"))).body);
    bodies.push((await h.call("GET", "/api/access-tokens/organization", as("admin"))).body);
    bodies.push((await h.create("contributor", "00000000-0000-7000-8000-000000000000")).body);
    bodies.push((await h.create("contributor", h.world().projects.priv, { name: "" })).body);
    bodies.push((await h.call("DELETE", `/api/access-tokens/${created.body.id}`, as("manager"))).body);
    bodies.push((await h.call("DELETE", `/api/access-tokens/${created.body.id}`, as("contributor"))).body);
    bodies.push((await h.call("DELETE", `/api/access-tokens/${created.body.id}`, as("contributor"))).body);
    bodies.push((await h.call("GET", "/api/me", as("contributor"))).body);
    expect((await service.resolve(token, "PRIV")).ok).toBe(false);

    const events = (await h.pool.query("select * from activity_events")).rows;
    const stored = (await h.pool.query("select * from access_tokens")).rows;
    const logs = captured.join("\n");

    for (const secretText of [token, secret, hash]) {
      expect(JSON.stringify(events), "eventos").not.toContain(secretText);
      expect(JSON.stringify(bodies), "respostas").not.toContain(secretText);
      expect(logs, "logs").not.toContain(secretText);
    }
    // O banco guarda o resumo, e só ele: nunca o token nem o segredo.
    expect(JSON.stringify(stored)).toContain(hash);
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(JSON.stringify(stored)).not.toContain(secret);
    // Os logs que existem identificam o registro pelo id.
    expect(logs).toContain(created.body.id);
  });
});
