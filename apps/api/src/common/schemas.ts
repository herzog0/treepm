import { z } from "zod";

/** Chave de projeto: 2 a 10 caracteres, A-Z e 0-9, começando por letra. */
export const PROJECT_KEY_PATTERN = /^[A-Z][A-Z0-9]{1,9}$/;
export const idSchema = z.uuid();
export const nameSchema = z.string().trim().min(1).max(120);
export const teamRoleSchema = z.enum(["admin", "member"]);
export const projectRoleSchema = z.enum(["manager", "contributor", "reader"]);
export const visibilitySchema = z.enum(["organization", "private"]);

export const nameBodySchema = z.object({ name: nameSchema }).strict();
export const idOutput = z.object({ id: z.string(), name: z.string() });
