import { createCipheriv, createDecipheriv, createHash } from "node:crypto";

/**
 * Cursor opaco das mensagens do chat (Revisão 1 da ADR 0049). O `seq` do banco é uma sequência só para todas as organizações: expô-lo
 * deixaria quem compara dois valores seguidos saber quantas mensagens todo mundo gravou no intervalo. Por isso a API só fala em
 * cursor: o `seq` cifrado (AES-128, um bloco) junto de uma marca da organização, de modo que o valor não revela ordem nem volume e
 * um cursor inventado ou de outra organização não decifra. Escolhi isto a um número por chat/thread porque o ponto de leitura e as
 * não lidas atravessam a conversa e as threads de um ticket, e a ordem global continua a única comparável sem tabela nova. A chave
 * deriva do segredo que a API já tem (nenhuma variável de ambiente nova); trocá-lo só invalida cursores guardados na tela.
 */
const keyOf = (secret: string): Buffer => createHash("sha256").update(`treepm-chat-cursor:${secret}`).digest().subarray(0, 16);
const markOf = (orgId: string): Buffer => createHash("sha256").update(`org:${orgId}`).digest().subarray(0, 8);

export function encodeChatCursor(secret: string, orgId: string, seq: bigint): string {
  const block = Buffer.alloc(16);
  block.writeBigUInt64BE(seq, 0);
  markOf(orgId).copy(block, 8);
  const cipher = createCipheriv("aes-128-ecb", keyOf(secret), null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block), cipher.final()]).toString("base64url");
}

/** O `seq` do cursor, ou `null` se não for um cursor desta API para esta organização. */
export function decodeChatCursor(secret: string, orgId: string, cursor: string): bigint | null {
  if (!/^[A-Za-z0-9_-]{22}$/.test(cursor)) return null;
  const raw = Buffer.from(cursor, "base64url");
  if (raw.length !== 16) return null;
  const decipher = createDecipheriv("aes-128-ecb", keyOf(secret), null);
  decipher.setAutoPadding(false);
  const block = Buffer.concat([decipher.update(raw), decipher.final()]);
  if (!block.subarray(8).equals(markOf(orgId))) return null;
  const seq = block.readBigUInt64BE(0);
  return seq <= 0x7fffffffffffffffn ? seq : null;
}
