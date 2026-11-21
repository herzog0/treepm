import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** O `state` da conexão vale 10 minutos (ADR 0032). */
export const STATE_TTL_MS = 10 * 60 * 1000;

const KEY_LABEL = "treepm:github:connect-state:v1";

type Subject = { orgId: string; userId: string };
type Payload = Subject & { nonce: string; expiresAt: number };

/** Chave de assinatura derivada do segredo de cliente do app com um rótulo fixo: o segredo cru nunca assina nada. */
function signingKey(secret: string): Buffer {
  return createHmac("sha256", secret).update(KEY_LABEL).digest();
}

function signature(secret: string, payload: string): Buffer {
  return createHmac("sha256", signingKey(secret)).update(payload).digest();
}

/**
 * `state` assinado, sem tabela: `base64url(JSON{orgId, userId, nonce, expiresAt}).base64url(HMAC-SHA256)`.
 * Vai na URL de instalação do GitHub e volta no retorno; só vale para a organização e o usuário que o pediram.
 */
export function signState(secret: string, subject: Subject, now: Date, nonce: string = randomBytes(16).toString("base64url")): string {
  const payload: Payload = { orgId: subject.orgId, userId: subject.userId, nonce, expiresAt: now.getTime() + STATE_TTL_MS };
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  return `${encoded}.${signature(secret, encoded).toString("base64url")}`;
}

/** Íntegro (assinatura em tempo constante), no prazo e da mesma organização e do mesmo usuário da sessão. */
export function verifyState(secret: string, token: string, subject: Subject, now: Date): boolean {
  const parts = token.split(".");
  if (parts.length !== 2) return false;
  const [encoded, given] = parts as [string, string];
  if (encoded.length === 0 || given.length === 0) return false;
  const expected = signature(secret, encoded);
  const received = Buffer.from(given, "base64url");
  if (received.length !== expected.length || !timingSafeEqual(received, expected)) return false;
  let payload: unknown;
  try {
    payload = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8"));
  } catch {
    return false;
  }
  if (typeof payload !== "object" || payload === null) return false;
  const { orgId, userId, expiresAt } = payload as Partial<Payload>;
  if (typeof orgId !== "string" || typeof userId !== "string" || typeof expiresAt !== "number") return false;
  return orgId === subject.orgId && userId === subject.userId && now.getTime() < expiresAt;
}
