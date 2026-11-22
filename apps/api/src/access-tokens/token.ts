import { createHash, randomBytes } from "node:crypto";

/** Prefixo fixo do token (ADR 0038): `tpm_<referência da organização>_<segredo>`. */
export const TOKEN_PREFIX = "tpm_";
const SECRET_BYTES = 32;
/** Teto do token inteiro: acima disso nem se tenta desmontar (`tpm_` + referência de até 64 caracteres + `_` + 43). */
export const MAX_TOKEN_LENGTH = 256;
/** Formato dos ids de organização do Clerk (`org_…`); o banco recusa NUL e o resto não é id de organização. */
const ORG_ID_SHAPE = /^[A-Za-z0-9_]{1,64}$/;
/** 32 bytes em base64url, sem preenchimento. O segredo é sempre o último trecho, de tamanho fixo. */
const SECRET_LENGTH = 43;
/** Quantos caracteres do segredo ficam guardados em claro, para a pessoa reconhecer o token. */
export const PREFIX_LENGTH = 8;

// A referência pode conter `_`; por isso o segredo, de tamanho fixo, é o que ancora o fim.
const TOKEN_SHAPE = new RegExp(`^${TOKEN_PREFIX}([A-Za-z0-9_-]+)_([A-Za-z0-9_-]{${SECRET_LENGTH}})$`);

export type BuiltToken = {
  /** O token inteiro. Existe só na resposta da criação; nunca é guardado. */
  token: string;
  secret: string;
  /** Primeiros caracteres do segredo (guardados). */
  prefix: string;
  /** SHA-256 do token inteiro, em hexadecimal (guardado). */
  hash: string;
};

export type ParsedToken = { orgId: string; secret: string };

/** SHA-256 do token inteiro, em hexadecimal. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Monta um token novo para a organização, com 256 bits aleatórios. */
export function buildToken(orgId: string, random: (size: number) => Buffer = randomBytes): BuiltToken {
  const secret = random(SECRET_BYTES).toString("base64url");
  const token = `${TOKEN_PREFIX}${Buffer.from(orgId, "utf8").toString("base64url")}_${secret}`;
  return { token, secret, prefix: secret.slice(0, PREFIX_LENGTH), hash: hashToken(token) };
}

/** Decodifica base64url só se a forma for a canônica (sem bits sobrando) e, quando `text`, UTF-8 válido. */
function decodeCanonical(value: string): Buffer | null {
  const bytes = Buffer.from(value, "base64url");
  return bytes.toString("base64url") === value ? bytes : null;
}

/** Desmonta um token. `null` para qualquer forma inválida: nunca lança. */
export function parseToken(raw: string): ParsedToken | null {
  if (raw.length > MAX_TOKEN_LENGTH) return null;
  const match = TOKEN_SHAPE.exec(raw);
  if (!match) return null;
  const [, reference, secret] = match;
  if (reference === undefined || secret === undefined) return null;
  const orgBytes = decodeCanonical(reference);
  const secretBytes = decodeCanonical(secret);
  if (!orgBytes || orgBytes.length === 0 || secretBytes?.length !== SECRET_BYTES) return null;
  let orgId: string;
  try {
    orgId = new TextDecoder("utf-8", { fatal: true }).decode(orgBytes);
  } catch {
    return null;
  }
  if (!ORG_ID_SHAPE.test(orgId)) return null;
  return { orgId, secret };
}
