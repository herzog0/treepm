import { z } from "zod";
import { AI_CONSENT_KINDS } from "@treepm/domain";

export const consentKindSchema = z.enum(AI_CONSENT_KINDS);

/** Quem aceita diz qual versão dos documentos viu: se ela mudou enquanto a tela estava aberta, o aceite não é gravado. */
export const acceptConsentSchema = z.object({ version: z.string().min(1).max(80) }).strict();

const consentSchema = z.object({
  inForce: z.boolean(),
  /** Versão da linha aberta (não retirada), mesmo desatualizada; `null` sem aceite aberto. */
  version: z.string().nullable(),
  acceptedBy: z.string().nullable(),
  acceptedAt: z.string().nullable(),
  /** Há aceite aberto, mas de uma versão que não é a atual: precisa aceitar de novo. */
  outdated: z.boolean(),
});

export const consentStateSchema = z.object({
  currentVersion: z.string(),
  assistant: consentSchema,
  codeReading: consentSchema.extend({
    githubConnected: z.boolean(),
    /** GitHub ligado na organização e assistente em vigor: o aceite da leitura de código pode ser dado. */
    offerable: z.boolean(),
  }),
});

export type ConsentState = z.output<typeof consentStateSchema>;
