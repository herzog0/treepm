import { BadRequestException, InternalServerErrorException, UnprocessableEntityException } from "@nestjs/common";
import type { PipeTransform } from "@nestjs/common";
import type { z } from "zod";

/** Pipe de entrada: valida com Zod e responde 400 sem expor detalhes além dos campos. */
export class ZodPipe<S extends z.ZodType> implements PipeTransform<unknown, z.output<S>> {
  constructor(private readonly schema: S) {}

  transform(value: unknown): z.output<S> {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      // Nome de pessoa em formato de menção em texto que vai à IA ou ao MCP: 422 com o código próprio, não um 400 genérico.
      const refused = result.error.issues.some((issue) => (issue as { params?: { code?: string } }).params?.code === "person_mention_not_allowed");
      if (refused) throw new UnprocessableEntityException({ code: "person_mention_not_allowed", message: "O texto não aceita menção de pessoa." });
      const fields = result.error.issues.map((issue) => issue.path.join(".") || "(raiz)").join(", ");
      throw new BadRequestException({ code: "validation_error", message: `Entrada inválida: ${fields}.` });
    }
    return result.data;
  }
}

/** Valida a saída; divergência é bug do servidor (500), nunca do cliente. */
export function parseOutput<S extends z.ZodType>(schema: S, value: unknown): z.output<S> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new InternalServerErrorException("Resposta fora do contrato.");
  }
  return result.data;
}
