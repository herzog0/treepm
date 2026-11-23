import { ConflictException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { isConnectionWaitTimeout } from "../common/connection-wait.js";

/**
 * Trava de estrutura da árvore de tickets (ADR 0045): toda transação que muda a estrutura de um projeto (pai, criação com
 * pai, remoção, ideia, importação, criação pela conversa) a pega logo no começo, e ela dura até o fim da transação.
 * Quem chega depois espera e faz as suas conferências já enxergando o que a anterior gravou.
 *
 * É uma trava consultiva do PostgreSQL por transação (`pg_advisory_xact_lock`), com a chave derivada do projeto num
 * espaço próprio (`ticket-structure:`, distinto de `ticket-dependencies:` e `comment-request:`). Não bloqueia leituras nem
 * edições que não mexem na estrutura. É função do sistema: o papel `treepm_app` a chama sem grant.
 */
export const structureLock = {
  /**
   * Quanto a transação espera pela trava antes de desistir com 409 `structure_busy`. Quem segura a trava só a segura durante
   * a própria requisição (milissegundos a poucos segundos, no caso da importação); 3 s cobre a fila normal de agentes
   * escrevendo no mesmo projeto e deixa folga: o prazo da transação é de 15 s (`tenantTransaction` em `@treepm/db`), cinco vezes
   * a espera, então quem consegue a trava no último instante ainda tem orçamento para conferir e gravar.
   */
  timeoutMs: 3000,
};

/** Transações que pegaram a trava: só nelas o estouro do prazo da transação vira `structure_busy`. */
const structureTransactions = new WeakSet<object>();

/** O 409 `structure_busy`: a espera pela trava, ou pela fila que vem antes dela, estourou. */
export const structureBusy = (): ConflictException =>
  new ConflictException({
    code: "structure_busy",
    message: "Outra mudança na estrutura deste projeto está em andamento. Tente de novo em instantes.",
  });

/**
 * O Prisma fechou a transação já aberta por prazo (P2028). A mesma sigla P2028 também é a da espera por conexão que estourou
 * (`isConnectionWaitTimeout`, que vira 503 `server_busy`): aqui ela não conta.
 */
function isTransactionTimeout(error: unknown): boolean {
  if (isConnectionWaitTimeout(error)) return false;
  const e = error as { code?: unknown; message?: unknown };
  return e?.code === "P2028" || (typeof e?.message === "string" && /Transaction already closed|P2028/.test(e.message));
}

/**
 * Envolve a abertura de uma transação do tenant: se ela estourar o prazo depois de ter pego a trava de estrutura, a resposta é
 * 409 `structure_busy` ("tente de novo"), não 500. `watch(tx)` deve ser chamado com a transação assim que ela abrir.
 */
export async function withStructureTimeoutTranslation<T>(body: (watch: (tx: TenantClient) => void) => Promise<T>): Promise<T> {
  let current: TenantClient | undefined;
  try {
    return await body((tx) => {
      current = tx;
    });
  } catch (error) {
    if (current !== undefined && structureTransactions.has(current) && isTransactionTimeout(error)) throw structureBusy();
    throw error;
  }
}

/** A recusa do PostgreSQL por `lock_timeout` (SQLSTATE 55P03), seja qual for a camada do Prisma que a embrulhou. */
function isLockTimeout(error: unknown): boolean {
  const e = error as {
    code?: unknown;
    message?: unknown;
    meta?: { code?: unknown; message?: unknown; driverAdapterError?: { cause?: { originalCode?: unknown; originalMessage?: unknown } } };
  };
  const codes = [e?.code, e?.meta?.code, e?.meta?.driverAdapterError?.cause?.originalCode];
  if (codes.includes("55P03")) return true;
  const texts = [e?.message, e?.meta?.message, e?.meta?.driverAdapterError?.cause?.originalMessage];
  return texts.some((text) => typeof text === "string" && (text.includes("55P03") || text.includes("lock timeout")));
}

/**
 * Pega a trava de estrutura do projeto na transação corrente (reentrante: pegar de novo na mesma transação não espera).
 * O `lock_timeout` vale só para esta espera e é devolvido ao valor anterior em seguida, para não limitar as travas de linha
 * que vêm depois. Estourou: 409 `structure_busy` (a tela mostra "tente de novo"); a transação desfaz tudo.
 * Os serviços chamam esta função ANTES de qualquer conferência que leia a árvore.
 */
export async function lockProjectStructure(tx: TenantClient, projectId: string): Promise<void> {
  structureTransactions.add(tx);
  const previous = (await tx.$queryRaw<{ value: string }[]>`select current_setting('lock_timeout') as value`)[0]?.value ?? "0";
  await tx.$executeRaw`select set_config('lock_timeout', ${`${structureLock.timeoutMs}ms`}, true)`;
  try {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`ticket-structure:${projectId}`}, 0))`;
  } catch (error) {
    if (isLockTimeout(error)) {
      throw structureBusy();
    }
    throw error;
  }
  await tx.$executeRaw`select set_config('lock_timeout', ${previous}, true)`;
}
