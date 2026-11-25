import { ConflictException } from "@nestjs/common";

/** Violação de unicidade do Prisma (`P2002`). */
export function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
}

/**
 * Nome da restrição UNIQUE violada (índice ou chave primária), como o PostgreSQL a informa pelo adaptador do Prisma; `null` se o
 * erro não for uma violação de unicidade ou o nome não vier.
 */
export function uniqueConstraintName(error: unknown): string | null {
  if (!isUniqueViolation(error)) return null;
  const cause = (error as { meta?: { driverAdapterError?: { cause?: { constraint?: { index?: unknown }; originalMessage?: unknown } } } }).meta?.driverAdapterError?.cause;
  if (typeof cause?.constraint?.index === "string") return cause.constraint.index;
  const match = typeof cause?.originalMessage === "string" ? /unique constraint "([^"]+)"/.exec(cause.originalMessage) : null;
  return match?.[1] ?? null;
}

/** Converte uma violação de unicidade em 409 com código estável; outros erros passam. */
export async function orConflict<T>(code: string, message: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error)) throw new ConflictException({ code, message });
    throw error;
  }
}
