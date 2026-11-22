import { describe, expect, it } from "vitest";
import { buildToken, hashToken, parseToken } from "../src/access-tokens/token.js";

describe("formato do token", () => {
  it("monta tpm_<referência>_<segredo> e desmonta de volta", () => {
    const built = buildToken("org_ABC123");
    expect(built.token).toMatch(/^tpm_[A-Za-z0-9_-]+_[A-Za-z0-9_-]{43}$/);
    expect(parseToken(built.token)).toEqual({ orgId: "org_ABC123", secret: built.secret });
  });

  it("a referência é o org_id em base64url sem preenchimento", () => {
    const built = buildToken("org_ABC123");
    expect(built.token.startsWith(`tpm_${Buffer.from("org_ABC123").toString("base64url")}_`)).toBe(true);
    expect(built.token).not.toContain("=");
  });

  it("o segredo tem 32 bytes aleatórios e cada token é diferente", () => {
    const a = buildToken("org_A");
    const b = buildToken("org_A");
    expect(Buffer.from(a.secret, "base64url")).toHaveLength(32);
    expect(a.token).not.toBe(b.token);
  });

  it("guarda os 8 primeiros caracteres do segredo e o SHA-256 do token inteiro em hexadecimal", () => {
    const built = buildToken("org_A");
    expect(built.prefix).toBe(built.secret.slice(0, 8));
    expect(built.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(built.hash).toBe(hashToken(built.token));
  });

  it("desmonta ids de organização do Clerk, inclusive com _ no meio e o tamanho máximo", () => {
    for (const orgId of ["org_2aB9xYz", "org_a_b_c", "o", "x".repeat(64)]) {
      const built = buildToken(orgId);
      expect(parseToken(built.token), orgId).toEqual({ orgId, secret: built.secret });
    }
  });

  it("recusa token malformado", () => {
    const good = buildToken("org_A").token;
    const secret = good.slice(-43);
    const ref = Buffer.from("org_A").toString("base64url");
    const cases = [
      "",
      "tpm_",
      "tpm__",
      "abc",
      good.replace(/^tpm_/, "xyz_"),
      good.replace(/^tpm_/, "TPM_"),
      `tpm_${ref}-${secret}`, // separador errado
      `tpm_${ref}_${secret}x`, // segredo comprido demais
      `tpm_${ref}_${secret.slice(1)}`, // segredo curto demais
      `tpm_${ref}_${secret.slice(0, 42)}!`, // caractere fora de base64url
      ` ${good}`,
      `${good}\n`,
      `tpm__${secret}`, // referência vazia
    ];
    for (const raw of cases) expect(parseToken(raw), JSON.stringify(raw)).toBeNull();
  });

  it("recusa referência que não decodifica", () => {
    const secret = buildToken("org_A").secret;
    expect(parseToken(`tpm_*_${secret}`)).toBeNull();
    // Não canônica: o último caractere tem bits sobrando que um decodificador frouxo ignoraria.
    expect(parseToken(`tpm_b3JnX1_${secret}`)).toBeNull();
    // Bytes que não são UTF-8 válido.
    expect(parseToken(`tpm_${Buffer.from([0xff, 0xfe]).toString("base64url")}_${secret}`)).toBeNull();
  });

  it("recusa segredo de tamanho certo mas que não decodifica para 32 bytes canônicos", () => {
    const ref = Buffer.from("org_A").toString("base64url");
    // 43 caracteres terminando em "B": os dois bits finais não são zero, logo não é a codificação de 32 bytes.
    expect(parseToken(`tpm_${ref}_${"A".repeat(42)}B`)).toBeNull();
    expect(parseToken(`tpm_${ref}_${"A".repeat(43)}`)).toEqual({ orgId: "org_A", secret: "A".repeat(43) });
  });

  it("recusa organização fora de ^[A-Za-z0-9_]{1,64}$ e token acima de 256 caracteres, sem lançar", () => {
    const secret = buildToken("org_A").secret;
    const withOrg = (orgId: string) => `tpm_${Buffer.from(orgId).toString("base64url")}_${secret}`;
    expect(parseToken(`tpm_AA_${"A".repeat(43)}`)).toBeNull(); // organização "\u0000"
    for (const orgId of ["a\u0000b", "org\u0001", "org A", "org-A", "org/A", "órg", "", "x".repeat(65)]) {
      expect(parseToken(withOrg(orgId)), JSON.stringify(orgId)).toBeNull();
    }
    expect(parseToken(withOrg("x".repeat(64)))).toEqual({ orgId: "x".repeat(64), secret });
    expect(parseToken(withOrg("org_2aB9"))?.orgId).toBe("org_2aB9");
    const huge = `tpm_${"A".repeat(5000)}_${secret}`;
    expect(parseToken(huge)).toBeNull();
    expect(parseToken(`tpm_${"A".repeat(300)}_${secret}`)).toBeNull();
    expect(parseToken("t".repeat(1_000_000))).toBeNull();
  });
});
