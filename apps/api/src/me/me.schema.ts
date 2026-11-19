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
  roles: z.object({
    clerk: z.enum(["admin", "member"]),
    teams: z.array(z.object({ teamId: z.string(), role: z.enum(["admin", "member"]) })),
    projects: z.array(
      z.object({ projectId: z.string(), role: z.enum(["manager", "contributor", "reader"]) }),
    ),
  }),
});

export type MeResponse = z.output<typeof meResponseSchema>;
