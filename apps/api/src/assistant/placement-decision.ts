import type { Prisma, TenantClient } from "@treepm/db";
import { z } from "zod";
import type { PlacementOutcome } from "./placement-search.js";
import type { PlacementRule } from "./related-placement.js";

/**
 * A decisão da procura guardada (ADR 0052, item 5; migration 0028): SÓ identificadores e números. O schema é estrito de
 * propósito: um campo de texto que alguém acrescente ao rastro é recusado aqui, antes de chegar ao banco. Nenhum título,
 * trecho de descrição, rascunho ou texto de conversa passa por este arquivo.
 */
const id = z.string().uuid();
const probability = z.number().min(0).max(1);

export const decisionLevelSchema = z
  .object({
    level: z.number().int().min(1),
    parentId: id.nullable(),
    parentNumber: z.number().int().nullable(),
    result: z.enum(["descended", "band", "below_low", "no_candidates", "too_large"]),
    belongs: probability.nullable(),
    candidates: z.array(z.object({ ticketId: id, number: z.number().int(), probability }).strict()),
  })
  .strict();

/** Um relacionado da decisão (ADR 0052, fatia 2): só o id, o número e as duas probabilidades do Jev. */
export const decisionRelatedSchema = z.object({ ticketId: id, number: z.number().int(), sameSubject: probability, sameRequest: probability }).strict();

/** O diagnóstico do passo de vetor (ADR 0053): só números e um código curto. */
export const semanticDiagnosticsSchema = z
  .object({
    synced: z.number().int().min(0),
    embedded: z.number().int().min(0),
    pending: z.number().int().min(0),
    syncMs: z.number().int().min(0),
    queryMs: z.number().int().min(0),
    failure: z.string().regex(/^[a-z_]{1,32}$/).optional(),
  })
  .strict();

/**
 * A triagem da procura guardada (migration 0031): quantos candidatos cada lista deu e o que o passo de vetor fez. `words` e `vector`
 * são os tamanhos das duas listas, `both` o que está nas duas, `onlyVector` quantos dos candidatos enviados só o vetor achou e
 * `sent` quantos foram ao Jev (depois do corte por tamanho). Só números e códigos.
 */
export const triageSchema = z
  .object({
    words: z.number().int().min(0),
    vector: z.number().int().min(0),
    both: z.number().int().min(0),
    onlyVector: z.number().int().min(0),
    sent: z.number().int().min(0),
    semantic: semanticDiagnosticsSchema,
  })
  .strict();
export type TriageNumbers = z.output<typeof triageSchema>;

/**
 * O que a procura decidiu sobre perguntar (ADR 0054, adendo): só identificadores e números, dentro do JSON `triage`
 * (`{ ...triagem, doubt }`; a coluna só exige um objeto). `draftMark` é o hash do rascunho que a procura viu (nunca o texto):
 * a criação "pelo destino da procura" só vale se ele ainda bate. `confirmed` é "o destino é confirmado, sem pergunta aberta".
 * `startId` é o ramo que a pessoa confirmou por último, se a procura partiu de um. `question` é a pergunta feita, se houve.
 */
export const doubtRecordSchema = z
  .object({
    draftMark: z.string().regex(/^[0-9a-f]{16}$/),
    confirmed: z.boolean(),
    startId: id.nullable(),
    question: z
      .object({
        level: z.number().int().min(1),
        kind: z.enum(["fit", "which", "root", "related", "interrupted"]),
        parentId: id.nullable(),
        options: z.array(z.object({ ticketId: id, number: z.number().int(), probability: probability.nullable() }).strict()),
      })
      .strict()
      .nullable(),
  })
  .strict();
export type DoubtRecord = z.output<typeof doubtRecordSchema>;

/** De que tipo foi a escolha do lugar na criação (ADR 0054, adendo): a procura, uma opção da pergunta, "fica aqui", um lugar recente ou o mapa. */
export const PLACED_BY = ["search", "option", "stay", "recent", "map"] as const;
export type PlacedBy = (typeof PLACED_BY)[number];

export const decisionSchema = z
  .object({
    uncertain: z.boolean(),
    stopReason: z.enum(["no_candidates", "below_low", "band", "candidates_too_large", "max_levels"]).nullable(),
    chosenPath: z.array(id),
    alternatives: z.array(z.array(id)),
    scope: z.object({ ticketId: id, fit: probability.nullable() }).strict().nullable(),
    levels: z.array(decisionLevelSchema),
    /** Os relacionados em ordem de probabilidade; vazio em decisão guardada antes da migration 0029. */
    related: z.array(decisionRelatedSchema).default([]),
    /** O relacionado apontado como o mesmo pedido, se houve. */
    duplicateTicketId: id.nullable().default(null),
    /** Qual regra decidiu o lugar (`descent` sem relacionado que gere destino); `null` em decisão antiga. */
    rule: z.enum(["descent", "related_within", "related_ancestor", "related_choice", "choice_unavailable"]).nullable().default(null),
    /** A triagem de relacionados (palavras e vetor); `null` em decisão guardada antes da migration 0031 ou sem triagem. */
    triage: triageSchema.nullable().default(null),
    /** A marca do rascunho, o destino confirmado ou não e a pergunta feita (ADR 0054); `null` em decisão antiga. */
    doubt: doubtRecordSchema.nullable().default(null),
  })
  .strict();
export type PlacementDecisionRecord = z.output<typeof decisionSchema>;

export type DecisionExtras = {
  related: readonly { id: string; sameSubject: number; sameRequest: number }[];
  duplicateId: string | null;
  rule: PlacementRule;
  triage?: TriageNumbers | null;
  doubt?: DoubtRecord | null;
};

/** Do resultado da procura para o registro: `numberOf` dá o número de cada ticket (ids que não estão no mapa viram erro). */
export function decisionOf(outcome: Pick<PlacementOutcome, "uncertain" | "trace">, numberOf: ReadonlyMap<string, number>, extras?: DecisionExtras): PlacementDecisionRecord {
  const number = (ticketId: string): number => {
    const found = numberOf.get(ticketId);
    if (found === undefined) throw new Error("ticket do rastro fora da árvore lida");
    return found;
  };
  const { trace } = outcome;
  return decisionSchema.parse({
    uncertain: outcome.uncertain,
    stopReason: trace.stop,
    chosenPath: trace.chosen,
    alternatives: trace.alternatives,
    scope: trace.scope ? { ticketId: trace.scope.id, fit: trace.scope.fit } : null,
    levels: trace.steps.map((step) => ({
      level: step.level,
      parentId: step.parentId,
      parentNumber: step.parentId === null ? null : number(step.parentId),
      result: step.result,
      belongs: step.belongs,
      candidates: step.candidates.map((candidate) => ({ ticketId: candidate.ticketId, number: number(candidate.ticketId), probability: candidate.probability })),
    })),
    related: (extras?.related ?? []).map((entry) => ({ ticketId: entry.id, number: number(entry.id), sameSubject: entry.sameSubject, sameRequest: entry.sameRequest })),
    duplicateTicketId: extras?.duplicateId ?? null,
    rule: extras?.rule ?? null,
    triage: extras?.triage ?? null,
    doubt: extras?.doubt ?? null,
  });
}

/** O JSON da coluna `triage`: a triagem e a decisão sobre perguntar. `{}` continua sendo "nada". */
export const packTriage = (record: Pick<PlacementDecisionRecord, "triage" | "doubt">): Record<string, unknown> => ({ ...(record.triage ?? {}), ...(record.doubt ? { doubt: record.doubt } : {}) });
/** O inverso: separa as perguntas da triagem. Valor que não é objeto vira "sem nada". */
export function unpackTriage(raw: unknown): { triage?: unknown; doubt?: unknown } {
  if (typeof raw !== "object" || raw === null) return {};
  const { doubt, ...rest } = raw as Record<string, unknown>;
  return { ...(Object.keys(rest).length > 0 ? { triage: rest } : {}), ...(doubt === undefined ? {} : { doubt }) };
}

/**
 * Uma decisão por conversa: a procura nova substitui a anterior. Devolve `true` se gravou inteira (com a triagem e a dúvida) e `false`
 * se recuou para um banco sem a coluna `triage`: a decisão existe, mas sem a dúvida, e quem chama não pode confirmar destino nem perguntar.
 */
export async function saveDecision(
  tx: TenantClient,
  input: { orgId: string; projectId: string; conversationId: string; record: PlacementDecisionRecord },
): Promise<boolean> {
  const { record } = input;
  await tx.placementDecision.deleteMany({ where: { orgId: input.orgId, conversationId: input.conversationId } });
  // Três degraus, do mais novo ao mais antigo, para o servidor não quebrar antes de a migration ser aplicada: com a 0031 a decisão
  // leva também a triagem; só com a 0029, os relacionados; só com a 0028, o que havia. O recuo é em SQL: o Prisma poria as colunas
  // novas no INSERT (o padrão delas é do cliente), e elas não existem no banco anterior. Só coluna ausente (P2022 do Prisma,
  // 42703 do PostgreSQL) faz recuar; qualquer outro erro sobe e vira o aviso de decisão não guardada.
  const full = await guarded(tx, () =>
    tx.placementDecision.create({
      select: { id: true },
      data: {
        orgId: input.orgId,
        projectId: input.projectId,
        conversationId: input.conversationId,
        chosenPath: record.chosenPath,
        alternatives: record.alternatives,
        uncertain: record.uncertain,
        stopReason: record.stopReason,
        scopeTicketId: record.scope?.ticketId ?? null,
        scopeFit: record.scope?.fit ?? null,
        levels: record.levels,
        related: record.related,
        duplicateTicketId: record.duplicateTicketId,
        placementRule: record.rule,
        triage: packTriage(record) as Prisma.InputJsonObject,
      },
    }),
  );
  if (full.ok) return true;
  if (!MISSING_COLUMN.includes(full.code)) throw new Error(`decisão não gravada código=${full.code}`);
  const mid = await guarded(
    tx,
    () =>
      tx.$executeRaw`insert into placement_decisions (org_id, project_id, conversation_id, chosen_path, alternatives, uncertain, stop_reason, scope_ticket_id, scope_fit, levels, related, duplicate_ticket_id, placement_rule)
      values (${input.orgId}, ${input.projectId}::uuid, ${input.conversationId}::uuid, ${record.chosenPath}::uuid[], ${JSON.stringify(record.alternatives)}::jsonb, ${record.uncertain}, ${record.stopReason},
        ${record.scope?.ticketId ?? null}::uuid, ${record.scope?.fit ?? null}::double precision, ${JSON.stringify(record.levels)}::jsonb,
        ${JSON.stringify(record.related)}::jsonb, ${record.duplicateTicketId}::uuid, ${record.rule})`,
  );
  if (mid.ok) return false;
  if (!MISSING_COLUMN.includes(mid.code)) throw new Error(`decisão não gravada código=${mid.code}`);
  await tx.$executeRaw`insert into placement_decisions (org_id, project_id, conversation_id, chosen_path, alternatives, uncertain, stop_reason, scope_ticket_id, scope_fit, levels)
    values (${input.orgId}, ${input.projectId}::uuid, ${input.conversationId}::uuid, ${record.chosenPath}::uuid[], ${JSON.stringify(record.alternatives)}::jsonb, ${record.uncertain}, ${record.stopReason},
      ${record.scope?.ticketId ?? null}::uuid, ${record.scope?.fit ?? null}::double precision, ${JSON.stringify(record.levels)}::jsonb)`;
  return false;
}

/**
 * Grava de que tipo foi a escolha do lugar (migration 0032) na decisão da conversa. É diagnóstico e nunca derruba a criação:
 * sem a coluna (42703) não há o que gravar; qualquer outro erro volta como código para quem chama avisar no registro.
 */
export async function recordPlacedBy(tx: TenantClient, input: { conversationId: string; placedBy: PlacedBy }): Promise<string | null> {
  const result = await guarded(tx, () => tx.$executeRaw`update placement_decisions set placed_by = ${input.placedBy} where conversation_id = ${input.conversationId}::uuid`);
  return result.ok || result.code === "42703" ? null : result.code;
}

/** Códigos de coluna ausente: P2022 (Prisma) e 42703 (PostgreSQL). */
const MISSING_COLUMN = ["P2022", "42703"];

/**
 * O código para decidir o recuo: SQL cru no Prisma 7 vira `P2010` para QUALQUER falha; só vale como coluna ausente quando o
 * PostgreSQL disse `42703` (em `meta.driverAdapterError.cause.originalCode`). Os demais erros mantêm o código deles.
 */
export function guardCode(error: unknown): string {
  const code = errorCode(error);
  if (code !== "P2010") return code;
  const meta = (error as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown; code?: unknown } } } }).meta;
  const original = meta?.driverAdapterError?.cause?.originalCode ?? meta?.driverAdapterError?.cause?.code;
  return original === "42703" ? "42703" : code;
}

/** O código do erro (Prisma `code` ou `code` da exceção), nunca o texto: a mensagem pode trazer valores. */
export function errorCode(error: unknown): string {
  const code = typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
  return typeof code === "string" && /^[\w.-]{1,32}$/.test(code) ? code : error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Roda `work` num ponto de salvamento da transação: se falhar, desfaz só o trabalho dele e a transação segue válida
 * (um try/catch simples não basta, o PostgreSQL deixa a transação abortada). Devolve `failed` com o código do erro.
 */
async function guarded<T>(tx: TenantClient, work: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; code: string }> {
  await tx.$executeRaw`savepoint placement_decision_guard`;
  try {
    const value = await work();
    await tx.$executeRaw`release savepoint placement_decision_guard`;
    return { ok: true, value };
  } catch (error) {
    await tx.$executeRaw`rollback to savepoint placement_decision_guard`;
    return { ok: false, code: guardCode(error) };
  }
}

/**
 * Ao criar o ticket a decisão passa a ser dele: o dono troca na mesma transação e a conversa pode ser apagada sem levá-la.
 * É diagnóstico: se a troca falhar (tabela ausente, qualquer erro), a criação do ticket segue; devolve o código do erro.
 */
export async function handDecisionToTicket(tx: TenantClient, input: { orgId: string; conversationId: string; ticketId: string }): Promise<string | null> {
  const result = await guarded(tx, () =>
    tx.placementDecision.updateMany({
      where: { orgId: input.orgId, conversationId: input.conversationId },
      data: { ticketId: input.ticketId, conversationId: null },
    }),
  );
  return result.ok ? null : result.code;
}

/** Leitura segura: sem a tabela ou com qualquer falha, "sem decisão". */
export async function readDecisionSafely(tx: TenantClient, conversationId: string): Promise<PlacementDecisionRecord | null> {
  const result = await guarded(tx, () => readDecisionOfConversation(tx, conversationId));
  return result.ok ? result.value : null;
}

export async function readDecisionOfConversation(tx: TenantClient, conversationId: string): Promise<PlacementDecisionRecord | null> {
  // Do mais novo ao mais antigo: todas as colunas (0031); sem a triagem (0029); só as da 0028 (o registro sai sem relacionados).
  const attempt = await guarded(tx, () => tx.placementDecision.findFirst({ where: { conversationId } }));
  if (!attempt.ok && !MISSING_COLUMN.includes(attempt.code)) throw new Error(`decisão não lida código=${attempt.code}`);
  // Sem decisão não há segunda consulta: o recuo só roda quando alguma coluna não existe.
  const full = attempt.ok ? attempt.value : null;
  if (attempt.ok && full === null) return null;
  const common = { uncertain: true, stopReason: true, chosenPath: true, alternatives: true, scopeTicketId: true, scopeFit: true, levels: true } as const;
  let mid: { related: unknown; duplicateTicketId: string | null; placementRule: string | null } | null = null;
  let row: { uncertain: boolean; stopReason: string | null; chosenPath: string[]; alternatives: unknown; scopeTicketId: string | null; scopeFit: number | null; levels: unknown } | null = full;
  if (!full) {
    const second = await guarded(tx, () => tx.placementDecision.findFirst({ where: { conversationId }, select: { ...common, related: true, duplicateTicketId: true, placementRule: true } }));
    if (second.ok) {
      row = second.value;
      mid = second.value;
    } else if (MISSING_COLUMN.includes(second.code)) {
      row = await tx.placementDecision.findFirst({ where: { conversationId }, select: common });
    } else {
      throw new Error(`decisão não lida código=${second.code}`);
    }
  }
  if (!row) return null;
  const extra = full ?? mid;
  return decisionSchema.parse({
    uncertain: row.uncertain,
    stopReason: row.stopReason,
    chosenPath: row.chosenPath,
    alternatives: row.alternatives,
    scope: row.scopeTicketId ? { ticketId: row.scopeTicketId, fit: row.scopeFit } : null,
    levels: row.levels,
    ...(extra ? { related: extra.related, duplicateTicketId: extra.duplicateTicketId, rule: extra.placementRule } : {}),
    // `{}` (sem triagem por vetor) e coluna ausente são o mesmo: sem triagem. As perguntas (ADR 0054) vêm no mesmo JSON.
    ...(full ? unpackTriage(full.triage) : {}),
  });
}
