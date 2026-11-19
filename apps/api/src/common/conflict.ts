import { ConflictException } from "@nestjs/common";

/** Violação de unicidade do Prisma (`P2002`). */
function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";
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
