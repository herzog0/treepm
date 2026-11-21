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
