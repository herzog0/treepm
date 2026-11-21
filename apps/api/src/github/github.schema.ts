import { z } from "zod";

export const completeBodySchema = z
  .object({
    code: z.string().min(1).max(512),
    state: z.string().min(1).max(2048),
    installationId: z.number().int().positive().optional(),
  })
  .strict();
export type CompleteBody = z.output<typeof completeBodySchema>;

export const linkBodySchema = z.object({ repoId: z.number().int().positive() }).strict();

export const installationOutput = z.object({
  accountLogin: z.string(),
  accountType: z.string(),
  repositorySelection: z.enum(["all", "selected"]),
  connectedAt: z.string(),
});
export const installationEnvelope = z.object({ installation: installationOutput.nullable() });

export const providerRepositoryOutput = z.object({
  repoId: z.number(),
  fullName: z.string(),
  private: z.boolean(),
  htmlUrl: z.string(),
  defaultBranch: z.string(),
});
export const linkedRepositoryOutput = providerRepositoryOutput.extend({ id: z.string(), linkedAt: z.string() });
export type LinkedRepository = z.output<typeof linkedRepositoryOutput>;

export const codeRefreshOutput = z.object({
  refreshed: z.boolean(),
  syncedAt: z.string().nullable(),
  repositories: z.array(z.object({ id: z.string(), fullName: z.string(), status: z.enum(["ok", "truncated", "unavailable"]) })),
});
export type CodeRefresh = z.output<typeof codeRefreshOutput>;

export const ticketCodeOutput = z.object({
  repositories: z.number().int(),
  syncedAt: z.string().nullable(),
  links: z.array(
    z.object({
      id: z.string(),
      kind: z.enum(["branch", "pull_request"]),
      ticket: z.object({ id: z.string(), key: z.string(), title: z.string() }),
      repository: z.object({ fullName: z.string(), htmlUrl: z.string() }),
      ref: z.string(),
      number: z.number().int().nullable(),
      title: z.string().nullable(),
      state: z.enum(["active", "open", "merged", "closed"]),
      url: z.string(),
      updatedAt: z.string().nullable(),
    }),
  ),
});
export type TicketCode = z.output<typeof ticketCodeOutput>;
