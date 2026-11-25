import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/** Versão da chave de cifra gravada com cada segredo (ADR 0060): permite uma rotação futura sem adivinhar. */
export const CURRENT_KEY_VERSION = 1;

/** Dado autenticado: o segredo só decifra na linha (organização, pessoa, provedor) em que foi gravado. */
export type CredentialAad = { orgId: string; personId: string; provider: string };

export type SealedCredential = { ciphertext: Buffer; nonce: Buffer; keyVersion: number };

/** Falha ao cifrar ou decifrar. A mensagem é fixa: nunca cita segredo, texto cifrado, nonce nem chave. */
export class CredentialCipherError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CredentialCipherError";
  }
}

const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** Dado autenticado: `orgId|personId|provider|keyVersion`. A versão entra para que trocar `key_version` numa linha não decifre. */
export const credentialAadBytes = (aad: CredentialAad, keyVersion: number): Buffer => Buffer.from(`${aad.orgId}|${aad.personId}|${aad.provider}|${keyVersion}`, "utf8");

/**
 * AES-256-GCM com nonce aleatório de 12 bytes por gravação. A saída (`ciphertext`) leva a etiqueta de autenticação no fim.
 * O `keyVersion` 1 é a única chave que existe hoje; versão desconhecida falha.
 */
export class CredentialCipher {
  private readonly key: Buffer;

  constructor(key: Buffer) {
    if (key.length !== 32) throw new CredentialCipherError("A chave de cifra deve ter 32 bytes.");
    this.key = Buffer.from(key);
  }

  encrypt(plaintext: string, aad: CredentialAad): SealedCredential {
    const nonce = randomBytes(NONCE_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.key, nonce);
    cipher.setAAD(credentialAadBytes(aad, CURRENT_KEY_VERSION));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { ciphertext: Buffer.concat([body, cipher.getAuthTag()]), nonce, keyVersion: CURRENT_KEY_VERSION };
  }

  decrypt(sealed: SealedCredential, aad: CredentialAad): string {
    if (sealed.keyVersion !== CURRENT_KEY_VERSION) throw new CredentialCipherError("Versão da chave de cifra desconhecida.");
    if (sealed.nonce.length !== NONCE_BYTES || sealed.ciphertext.length < TAG_BYTES) throw new CredentialCipherError("Credencial cifrada inválida.");
    try {
      const decipher = createDecipheriv("aes-256-gcm", this.key, sealed.nonce);
      decipher.setAAD(credentialAadBytes(aad, CURRENT_KEY_VERSION));
      decipher.setAuthTag(sealed.ciphertext.subarray(sealed.ciphertext.length - TAG_BYTES));
      return Buffer.concat([decipher.update(sealed.ciphertext.subarray(0, sealed.ciphertext.length - TAG_BYTES)), decipher.final()]).toString("utf8");
    } catch {
      // A exceção original é descartada: ela não carrega segredo, mas o motivo exato também não interessa a ninguém.
      throw new CredentialCipherError("Não foi possível decifrar a credencial.");
    }
  }
}
