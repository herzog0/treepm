import { commentBodyOf } from "@treepm/domain";
import { z } from "zod";

/** Corpo do comentário: aparado, de 1 a 10.000 caracteres (ADR 0040). */
const commentBodySchema = z.string().transform((raw, ctx) => {
  const body = commentBodyOf(raw);
  if (body === null) {
    ctx.addIssue({ code: "custom", message: "O comentário precisa ter de 1 a 10.000 caracteres." });
    return z.NEVER;
  }
  return body;
});

export const commentInputSchema = z.object({ body: commentBodySchema }).strict();
export type CommentInput = z.output<typeof commentInputSchema>;
