import { mentionsPersonRaw } from "@treepm/domain";
import { z } from "zod";
import { noPersonMention } from "../tickets/tickets.schema.js";

export const MAX_DRAFT_REQUEST = 2000;
export const MAX_DRAFT_DESCRIPTION = 20_000;

/** O pedido (de 1 a 2.000 caracteres depois de aparado) e o texto atual do editor, que pode não estar salvo. */
export const descriptionDraftBodySchema = z
  .object({
    request: z.string().trim().min(1).max(MAX_DRAFT_REQUEST).refine((text) => !mentionsPersonRaw(text), noPersonMention),
    description: z.string().max(MAX_DRAFT_DESCRIPTION).refine((text) => !mentionsPersonRaw(text), noPersonMention),
  })
  .strict();

export const descriptionDraftResponseSchema = z.object({ text: z.string().min(1).max(6000), model: z.string() });
export type DescriptionDraftResponse = z.output<typeof descriptionDraftResponseSchema>;
