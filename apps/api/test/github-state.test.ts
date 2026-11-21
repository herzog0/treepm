import { describe, expect, it } from "vitest";
import { STATE_TTL_MS, signState, verifyState } from "../src/github/state.js";

const SECRET = "segredo-do-cliente-github-1234567890";
const NOW = new Date("2026-11-21T12:00:00.000Z");
const subject = { orgId: "org_A", userId: "user_1" };

function decodePayload(token: string): Record<string, unknown> {
  const [payload] = token.split(".");
  return JSON.parse(Buffer.from(payload ?? "", "base64url").toString("utf8")) as Record<string, unknown>;
}

describe("state assinado da conexão com o GitHub", () => {
  it("assina e verifica para a mesma organização e o mesmo usuário", () => {
    const token = signState(SECRET, subject, NOW);
    expect(token).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
    expect(verifyState(SECRET, token, subject, NOW)).toBe(true);
    expect(verifyState(SECRET, token, subject, new Date(NOW.getTime() + 60_000))).toBe(true);
  });

  it("carrega organização, usuário, nonce e expiração de 10 minutos; nunca o segredo", () => {
    const token = signState(SECRET, subject, NOW);
    const payload = decodePayload(token);
    expect(payload).toMatchObject({ orgId: "org_A", userId: "user_1" });
    expect(typeof payload["nonce"]).toBe("string");
    expect((payload["nonce"] as string).length).toBeGreaterThanOrEqual(16);
    expect(payload["expiresAt"]).toBe(NOW.getTime() + STATE_TTL_MS);
    expect(STATE_TTL_MS).toBe(600_000);
    expect(token).not.toContain(SECRET);
    expect(JSON.stringify(payload)).not.toContain(SECRET);
  });

  it("cada assinatura leva um nonce novo", () => {
    expect(signState(SECRET, subject, NOW)).not.toBe(signState(SECRET, subject, NOW));
  });

  it("vence: vale até o instante da expiração, exclusive", () => {
    const token = signState(SECRET, subject, NOW);
    expect(verifyState(SECRET, token, subject, new Date(NOW.getTime() + STATE_TTL_MS - 1))).toBe(true);
    expect(verifyState(SECRET, token, subject, new Date(NOW.getTime() + STATE_TTL_MS))).toBe(false);
    expect(verifyState(SECRET, token, subject, new Date(NOW.getTime() + STATE_TTL_MS + 1))).toBe(false);
  });

  it("recusa state de outra organização e de outro usuário", () => {
    const token = signState(SECRET, subject, NOW);
    expect(verifyState(SECRET, token, { ...subject, orgId: "org_B" }, NOW)).toBe(false);
    expect(verifyState(SECRET, token, { ...subject, userId: "user_2" }, NOW)).toBe(false);
  });

  it("recusa assinatura com outro segredo", () => {
    const token = signState("outro-segredo-qualquer-123456", subject, NOW);
    expect(verifyState(SECRET, token, subject, NOW)).toBe(false);
  });

  it("recusa conteúdo adulterado (mesmo trocando a organização por uma que bate com a sessão)", () => {
    const token = signState(SECRET, subject, NOW);
    const [, signature] = token.split(".");
    const forged = Buffer.from(JSON.stringify({ ...decodePayload(token), orgId: "org_B" })).toString("base64url");
    expect(verifyState(SECRET, `${forged}.${signature}`, { ...subject, orgId: "org_B" }, NOW)).toBe(false);
    const extended = Buffer.from(JSON.stringify({ ...decodePayload(token), expiresAt: NOW.getTime() + 10 * STATE_TTL_MS })).toString("base64url");
    expect(verifyState(SECRET, `${extended}.${signature}`, subject, new Date(NOW.getTime() + 2 * STATE_TTL_MS))).toBe(false);
  });

  it("recusa assinatura adulterada, truncada, vazia ou de outro tamanho", () => {
    const token = signState(SECRET, subject, NOW);
    const [payload, signature = ""] = token.split(".");
    const flipped = `${signature.slice(0, -1)}${signature.endsWith("A") ? "B" : "A"}`;
    expect(verifyState(SECRET, `${payload}.${flipped}`, subject, NOW)).toBe(false);
    expect(verifyState(SECRET, `${payload}.${signature.slice(0, 10)}`, subject, NOW)).toBe(false);
    expect(verifyState(SECRET, `${payload}.${signature}${signature}`, subject, NOW)).toBe(false);
    expect(verifyState(SECRET, `${payload}.`, subject, NOW)).toBe(false);
  });

  it.each(["", ".", "abc", "a.b.c", "não-é-state", "%%%.%%%", "e30.e30"])("recusa lixo: %j", (garbage) => {
    expect(verifyState(SECRET, garbage, subject, NOW)).toBe(false);
  });

  it("a chave de assinatura é derivada do segredo com um rótulo fixo: assinar com o segredo cru não vale", async () => {
    const { createHmac } = await import("node:crypto");
    const token = signState(SECRET, subject, NOW);
    const [payload] = token.split(".");
    const raw = createHmac("sha256", SECRET).update(payload ?? "").digest("base64url");
    expect(verifyState(SECRET, `${payload}.${raw}`, subject, NOW)).toBe(false);
  });
});
