/** A frase de 503 `server_busy`, em qualquer rota (a tela a traduz pelo código; o MCP usa a sua, em inglês). */
export const SERVER_BUSY_MESSAGE = "O servidor está ocupado. Tente de novo em instantes.";

const ACQUISITION = "Unable to start a transaction in the given time";

/**
 * A espera por uma conexão do pool estourou (`maxWait` do Prisma, `tenantTransaction.maxWaitMs`): P2028 com "Unable to start a
 * transaction in the given time". Não é o estouro do prazo de uma transação JÁ aberta, que também é P2028 mas diz "expired
 * transaction" ou "Transaction already closed" (formas capturadas do Prisma 7). Olha a exceção e a causa.
 */
export function isConnectionWaitTimeout(error: unknown): boolean {
  const one = (e: unknown): boolean => {
    const x = e as { code?: unknown; message?: unknown } | null | undefined;
    return x?.code === "P2028" && typeof x.message === "string" && x.message.includes(ACQUISITION);
  };
  return one(error) || one((error as { cause?: unknown } | null | undefined)?.cause);
}
