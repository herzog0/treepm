import { z } from "zod";

/** O texto escrito pela pessoa para o agrupador (ADR 0033): de 1 a 1.000 caracteres depois de aparado. */
export const MAX_GROUP_TEXT = 1000;

export const groupTextBodySchema = z.object({ text: z.string().trim().min(1).max(MAX_GROUP_TEXT) }).strict();

/** O texto fixo do agrupador e quem o escreveu por último; o modelo, a marca e o autor não saem daqui. */
export const groupTextResponseSchema = z.object({
  summary: z.object({ text: z.string(), source: z.enum(["assistant", "person"]), updatedAt: z.string() }).nullable(),
});

export type GroupTextResponse = z.output<typeof groupTextResponseSchema>;
