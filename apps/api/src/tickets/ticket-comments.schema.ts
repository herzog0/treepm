import { commentBodyOf } from "@treepm/domain";
import { z } from "zod";
import { idSchema } from "../common/schemas.js";

/** Corpo do comentário: aparado, de 1 a 10.000 caracteres (ADR 0040). */
const commentBodySchema = z.string().transform((raw, ctx) => {
  const body = commentBodyOf(raw);
  if (body === null) {
    ctx.addIssue({ code: "custom", message: "O comentário precisa ter de 1 a 10.000 caracteres." });
    return z.NEVER;
  }
  return body;
});

/** Editar só leva o corpo. */
export const commentInputSchema = z.object({ body: commentBodySchema }).strict();
export type CommentInput = z.output<typeof commentInputSchema>;

/** Criar leva também a contribuição (área) do mesmo ticket, quando o comentário é dela (ADR 0041). */
export const createCommentSchema = z.object({ body: commentBodySchema, contributionId: idSchema.optional() }).strict();
export type CreateCommentInput = z.output<typeof createCommentSchema>;
