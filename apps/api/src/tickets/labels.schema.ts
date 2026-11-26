import { LABEL_COLORS } from "@treepm/domain";
import { z } from "zod";

/**
 * Etiquetas por projeto (ADR 0065). O nome chega cru (até 2 000 caracteres, para o corpo não crescer sem limite) e quem decide se vale é o
 * domínio (`cleanLabelName`): o que sobra vazio é 400 `label_name_invalid`, com a mensagem do serviço, não da validação do corpo.
 */
const rawName = z.string().max(2000);
export const labelColorSchema = z.enum(LABEL_COLORS);

export const createLabelSchema = z.object({ name: rawName, color: labelColorSchema.optional() }).strict();
export const updateLabelSchema = z
  .object({ name: rawName, color: labelColorSchema })
  .partial()
  .strict()
  .refine((value) => Object.keys(value).length > 0, "Informe ao menos um campo.");

/** Uma etiqueta a pôr no ticket: uma do projeto, pelo id, ou um nome (o que já existe com a mesma chave é reusado; o novo é criado). */
export const labelRefSchema = z.union([z.object({ labelId: z.uuid() }).strict(), z.object({ name: rawName }).strict()]);
/**
 * `POST tickets/:id/labels`: pôr e tirar num pedido só. Teto de itens folgado sobre o limite de 20 por ticket (quem troca o conjunto inteiro
 * manda 20 de cada lado); a mesma etiqueta nos dois lados é recusada.
 */
export const changeTicketLabelsSchema = z
  .object({ add: z.array(labelRefSchema).max(40).default([]), remove: z.array(z.uuid()).max(40).default([]) })
  .strict()
  .refine((value) => value.add.length + value.remove.length > 0, "Informe etiquetas para pôr ou tirar.")
  .refine((value) => {
    const removing = new Set(value.remove.map((id) => id.toLowerCase()));
    return !value.add.some((item) => "labelId" in item && removing.has(item.labelId.toLowerCase()));
  }, "A mesma etiqueta não pode ser posta e tirada no mesmo pedido.");

export const labelSchema = z.object({ id: z.string(), name: z.string(), color: labelColorSchema });
export const projectLabelSchema = labelSchema.extend({ ticketCount: z.number().int().min(0) });
export const ticketLabelsOutputSchema = z.object({ labels: z.array(labelSchema) });
export const deleteLabelOutputSchema = z.object({ ticketsAffected: z.number().int().min(0) });

export type LabelRef = z.output<typeof labelRefSchema>;
export type LabelView = z.output<typeof labelSchema>;
export type ProjectLabelView = z.output<typeof projectLabelSchema>;
