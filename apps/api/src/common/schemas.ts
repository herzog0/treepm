import { z } from "zod";

export const idSchema = z.uuid();
export const nameSchema = z.string().trim().min(1).max(120);
export const teamRoleSchema = z.enum(["admin", "member"]);
export const projectRoleSchema = z.enum(["manager", "contributor", "reader"]);
export const visibilitySchema = z.enum(["organization", "private"]);

export const nameBodySchema = z.object({ name: nameSchema }).strict();
export const idOutput = z.object({ id: z.string(), name: z.string() });
