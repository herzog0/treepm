import { z } from "zod";

export const ASK_QUESTION_MAX = 2000;
export const ASK_HISTORY_MAX = 20;
export const ASK_MESSAGE_MAX = 8000;
export const ASK_ANSWER_MAX = 8000;

/** A pergunta (de 1 a 2.000 caracteres depois de aparada) e a conversa anterior da tela, que não é guardada em lugar nenhum. */
export const askBodySchema = z.strictObject({
  question: z.string().trim().min(1).max(ASK_QUESTION_MAX),
  history: z
    .array(z.strictObject({ author: z.enum(["person", "assistant"]), body: z.string().trim().min(1).max(ASK_MESSAGE_MAX) }))
    .max(ASK_HISTORY_MAX)
    .default([]),
});

export const askResponseSchema = z.object({ text: z.string().min(1).max(ASK_ANSWER_MAX).refine((text) => text.trim() !== ""), model: z.string() });
export type AskResponse = z.output<typeof askResponseSchema>;
