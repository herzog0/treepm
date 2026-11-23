import { ConflictException } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";

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
   * a própria requisição (milissegundos a poucos segundos, no caso da importação); 5 s cobre a fila normal de agentes
   * escrevendo no mesmo projeto e fica abaixo dos limites de requisição do proxy, em vez de segurar a conexão indefinidamente.
   */
  timeoutMs: 5000,
};

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
  const previous = (await tx.$queryRaw<{ value: string }[]>`select current_setting('lock_timeout') as value`)[0]?.value ?? "0";
  await tx.$executeRaw`select set_config('lock_timeout', ${`${structureLock.timeoutMs}ms`}, true)`;
  try {
    await tx.$executeRaw`select pg_advisory_xact_lock(hashtextextended(${`ticket-structure:${projectId}`}, 0))`;
  } catch (error) {
    if (isLockTimeout(error)) {
      throw new ConflictException({
        code: "structure_busy",
        message: "Outra mudança na estrutura deste projeto está em andamento. Tente de novo em instantes.",
      });
    }
    throw error;
  }
  await tx.$executeRaw`select set_config('lock_timeout', ${previous}, true)`;
}
