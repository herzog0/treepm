import { createCipheriv, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CredentialCipher, CredentialCipherError, credentialAadBytes } from "../src/common/credential-cipher.js";

const KEY = Buffer.alloc(32, 9);
const aad = { orgId: "org_A", personId: "0190c0de-0000-7000-8000-000000000001", provider: "linear" };
const SECRET = "lin_api_SEGREDO_de_teste_1234";

describe("CredentialCipher (AES-256-GCM)", () => {
  const cipher = new CredentialCipher(KEY);

  it("o dado autenticado inclui a versão da chave: org|pessoa|provedor|versão", () => {
    expect(credentialAadBytes(aad, 1).toString("utf8")).toBe(`${aad.orgId}|${aad.personId}|linear|1`);
    expect(credentialAadBytes(aad, 2).equals(credentialAadBytes(aad, 1))).toBe(false);
    // Texto cifrado com o dado autenticado SEM a versão (formato antigo) não decifra, nem com a versão 1.
    const nonce = randomBytes(12);
    const raw = createCipheriv("aes-256-gcm", KEY, nonce);
    raw.setAAD(Buffer.from(`${aad.orgId}|${aad.personId}|linear`, "utf8"));
    const body = Buffer.concat([raw.update("x", "utf8"), raw.final(), raw.getAuthTag()]);
    expect(() => cipher.decrypt({ ciphertext: body, nonce, keyVersion: 1 }, aad)).toThrow(CredentialCipherError);
  });

  it("exige chave de 32 bytes", () => {
    expect(() => new CredentialCipher(Buffer.alloc(16))).toThrow(CredentialCipherError);
  });

  it("ida e volta, com versão 1 da chave e nonce de 12 bytes", () => {
    const sealed = cipher.encrypt(SECRET, aad);
    expect(sealed.keyVersion).toBe(1);
    expect(sealed.nonce).toHaveLength(12);
    expect(sealed.ciphertext.includes(Buffer.from(SECRET))).toBe(false);
    expect(cipher.decrypt(sealed, aad)).toBe(SECRET);
  });

  it("o mesmo texto gera nonces e textos cifrados diferentes", () => {
    const a = cipher.encrypt(SECRET, aad);
    const b = cipher.encrypt(SECRET, aad);
    expect(a.nonce.equals(b.nonce)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
  });

  it("texto adulterado não decifra", () => {
    const sealed = cipher.encrypt(SECRET, aad);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    expect(() => cipher.decrypt({ ...sealed, ciphertext: tampered }, aad)).toThrow(CredentialCipherError);
  });

  it("nonce adulterado não decifra", () => {
    const sealed = cipher.encrypt(SECRET, aad);
    const nonce = Buffer.from(sealed.nonce);
    nonce[0] = (nonce[0] ?? 0) ^ 1;
    expect(() => cipher.decrypt({ ...sealed, nonce }, aad)).toThrow(CredentialCipherError);
  });

  it.each([
    ["outra pessoa", { ...aad, personId: "0190c0de-0000-7000-8000-000000000002" }],
    ["outra organização", { ...aad, orgId: "org_B" }],
    ["outro provedor", { ...aad, provider: "github" }],
  ])("linha copiada para %s não decifra", (_name, other) => {
    const sealed = cipher.encrypt(SECRET, aad);
    expect(() => cipher.decrypt(sealed, other)).toThrow(CredentialCipherError);
  });

  it("chave de cifra diferente não decifra", () => {
    const sealed = cipher.encrypt(SECRET, aad);
    expect(() => new CredentialCipher(Buffer.alloc(32, 1)).decrypt(sealed, aad)).toThrow(CredentialCipherError);
  });

  it("versão de chave desconhecida falha com erro próprio", () => {
    const sealed = cipher.encrypt(SECRET, aad);
    expect(() => cipher.decrypt({ ...sealed, keyVersion: 2 }, aad)).toThrow(/versão/i);
  });

  it("o erro nunca carrega o segredo, o texto cifrado nem a chave", () => {
    const sealed = cipher.encrypt(SECRET, aad);
    const tampered = Buffer.from(sealed.ciphertext);
    tampered[0] = (tampered[0] ?? 0) ^ 1;
    try {
      cipher.decrypt({ ...sealed, ciphertext: tampered }, aad);
      throw new Error("deveria falhar");
    } catch (error) {
      const text = `${String(error)} ${JSON.stringify(error, Object.getOwnPropertyNames(error))}`;
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain(sealed.ciphertext.toString("base64"));
      expect(text).not.toContain(sealed.ciphertext.toString("hex"));
      expect(text).not.toContain(KEY.toString("base64"));
      expect(text).not.toContain(KEY.toString("hex"));
    }
  });
});
