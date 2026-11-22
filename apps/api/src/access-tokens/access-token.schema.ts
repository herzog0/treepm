import { z } from "zod";
import { idSchema } from "../common/schemas.js";

/** Validades aceitas, em dias; 90 quando não vier (ADR 0038). */
export const EXPIRES_IN_DAYS = [30, 90, 365] as const;
export const DEFAULT_EXPIRES_IN_DAYS = 90;
/** Tokens ativos (não revogados e não vencidos) por pessoa na organização. */
export const MAX_ACTIVE_TOKENS = 10;

export const createTokenSchema = z
  .object({
    projectId: idSchema,
    name: z.string().trim().min(1).max(80),
    expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365)]).default(DEFAULT_EXPIRES_IN_DAYS),
    /** Alcance (ADR 0043): `read` (padrão) ou `write`; não muda depois de criado. */
    scope: z.enum(["read", "write"]).default("read"),
  })
  .strict();
export type CreateTokenBody = z.output<typeof createTokenSchema>;

export const mcpSwitchSchema = z.object({ mcpEnabled: z.boolean() }).strict();
export const mcpWriteSwitchSchema = z.object({ mcpWriteEnabled: z.boolean() }).strict();
export const mcpStateSchema = z.object({ mcp: z.object({ enabled: z.boolean(), writeEnabled: z.boolean() }) });

/** Nunca inclui o token nem o resumo; o token inteiro só existe em `createdTokenSchema`. */
export const tokenSchema = z.object({
  id: z.string(),
  name: z.string(),
  project: z.object({ id: z.string(), key: z.string() }),
  tokenPrefix: z.string(),
  scope: z.enum(["read", "write"]),
  createdAt: z.string(),
  lastUsedAt: z.string().nullable(),
  expiresAt: z.string(),
  revokedAt: z.string().nullable(),
});
export const createdTokenSchema = tokenSchema.extend({ token: z.string() });
export const organizationTokenSchema = tokenSchema.extend({
  person: z.object({ id: z.string(), displayName: z.string() }),
});
export type TokenOutput = z.output<typeof tokenSchema>;
export type CreatedTokenOutput = z.output<typeof createdTokenSchema>;
export type OrganizationTokenOutput = z.output<typeof organizationTokenSchema>;
