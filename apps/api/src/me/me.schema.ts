import { z } from "zod";

export const meResponseSchema = z.object({
  person: z.object({
    id: z.string(),
    displayName: z.string(),
    email: z.string(),
    avatarUrl: z.string().nullable(),
  }),
  organization: z.object({
    orgId: z.string(),
    name: z.string(),
    slug: z.string(),
  }),
  /**
   * `configured`: o servidor tem as chaves dos provedores. `consent`: a organização aceitou o uso da IA (ADR 0039).
   * `enabled` só vale com as duas coisas e é o que a interface usa para mostrar ou esconder as funções de IA.
   */
  assistant: z.object({ configured: z.boolean(), consent: z.boolean(), enabled: z.boolean() }),
  github: z.object({ enabled: z.boolean() }),
  /** Chave da organização "Permitir acesso por MCP" (ADR 0038). */
  mcp: z.object({ enabled: z.boolean(), writeEnabled: z.boolean() }),
  roles: z.object({
    clerk: z.enum(["admin", "member"]),
    teams: z.array(z.object({ teamId: z.string(), role: z.enum(["admin", "member"]) })),
    projects: z.array(
      z.object({ projectId: z.string(), role: z.enum(["manager", "contributor", "reader"]) }),
    ),
  }),
});

export type MeResponse = z.output<typeof meResponseSchema>;
