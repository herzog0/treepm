import { z } from "zod";
import { idSchema } from "../common/schemas.js";

/** Abrir uma rodada: o destino (nulo = raiz do projeto) e se a categorização foi pedida (guardada; a fase ainda não roda). */
export const openRunBodySchema = z.object({ destinationTicketId: idSchema.nullable().optional(), categorize: z.boolean().optional() }).strict();

/** A rodada como a API a devolve. Nada do Linear além de contagens: nenhum e-mail, id do Linear ou texto. */
export type RunView = {
  id: string;
  projectId: string;
  mode: "first" | "reimport";
  phase: "projects" | "issues" | "hierarchy" | "statuses" | "mentions" | "comments" | "relations" | "missing" | "categorize" | "done" | "failed";
  /** A rodada terminou (`done` ou `failed`). */
  done: boolean;
  categorize: boolean;
  /** Nesta fatia a fase de categorização é pulada, mesmo com `categorize: true`. */
  categorizeAvailable: false;
  /** Contagens; `assigneeEmailUnavailable: true` quando o Linear recusou o e-mail dos responsáveis. */
  counts: Record<string, number | boolean>;
  /** Quantas issues o time tinha ao abrir (`null` se o Linear não respondeu a contagem). */
  totalExpected: number | null;
  /** O Linear limitou as consultas: o passo só é tentado depois desta hora. */
  waitUntil: string | null;
  lastErrorCode: string | null;
  /** Passos seguidos que falharam com o mesmo código: a tela oferece "Abandonar" quando passa de 2. */
  errorStreak: number;
  /** Itens por página de issues no momento (cai à metade quando a resposta estoura o teto). */
  pageSize: number;
  destinationTicketId: string | null;
  startedBy: { id: string };
  startedAt: string;
  updatedAt: string;
  finishedAt: string | null;
};
