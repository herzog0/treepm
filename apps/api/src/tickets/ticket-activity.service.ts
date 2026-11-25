import { BadRequestException, Injectable } from "@nestjs/common";
import type { TenantClient } from "@treepm/db";
import { canCommentTicket, canEditContributions, mergeDescriptionEdits } from "@treepm/domain";
import type { MergedEntry } from "@treepm/domain";
import { z } from "zod";
import { parseOutput } from "../common/zod.js";
import { activityPageSchema } from "./ticket-activity.schema.js";
import type { ActivityEntry, ActivityPage } from "./ticket-activity.schema.js";
import { commentRights, commentSelect, toCommentEntry } from "./ticket-comments.service.js";
import type { Viewer } from "./ticket-comments.service.js";
import { contributionStatusSchema, ideaStageSchema, ticketStatusSchema } from "./tickets.schema.js";
import type { ProjectRow } from "./tickets.service.js";

/** Tipos de evento que viram entradas; o resto (inclusive `ticket.comment_*`) nem é lido do banco. */
const READ_KINDS = [
  "ticket.created",
  "ticket.updated",
  "ticket.assignee_added",
  "ticket.assignee_removed",
  "ticket.dependency_added",
  "ticket.dependency_removed",
  "ticket.summary_updated",
  "ticket.contribution_added",
  "ticket.contribution_removed",
  "ticket.contribution_updated",
  "ticket.contribution_person_added",
  "ticket.contribution_person_removed",
  "ticket.idea_registered",
  "ticket.idea_stage_changed",
  "ticket.idea_accepted",
  "ticket.idea_discarded",
  "ticket.idea_reopened",
  "ticket.agent_work_started",
  "ticket.agent_work_ended",
];

/** Ordem fixa das entradas de um `ticket.updated`, da mais antiga para a mais nova. */
const FIELD_ORDER = ["title", "description", "status", "parentId", "priority"] as const;
/** Ordem fixa das entradas de um `ticket.contribution_updated`, da mais antiga para a mais nova. */
const CONTRIBUTION_FIELD_ORDER = ["text", "status"] as const;
const contributionRef = z.object({ contributionId: z.uuid(), areaId: z.uuid() });
const SYNTHETIC_ID = "";
const FIRST_BATCH_EXTRA = 5;
const MAX_BATCH = 500;

type Position = { t: number; e: string; s: number };
type CommentRow = Parameters<typeof toCommentEntry>[0];
type RefDraft = { id: string | null; key: string | null; number: number | null };
type Data =
  | { type: "created" }
  | { type: "title_changed"; from: string; to: string }
  | { type: "description_changed" }
  | { type: "status_changed"; from: z.output<typeof ticketStatusSchema>; to: z.output<typeof ticketStatusSchema>; automatic: boolean; causedBy: RefDraft | null }
  | { type: "priority_changed"; from: number; to: number }
  | { type: "parent_changed"; from: RefDraft | null; to: RefDraft | null }
  | { type: "assignee_added" | "assignee_removed"; personId: string }
  | { type: "dependency_added" | "dependency_removed"; ticket: RefDraft }
  | { type: "summary_updated"; source: "person" | "assistant" }
  | { type: "contribution_added" | "contribution_text_changed"; areaId: string }
  | { type: "contribution_removed"; areaId: string; areaName: string | null }
  | { type: "contribution_status_changed"; areaId: string; from: z.output<typeof contributionStatusSchema>; to: z.output<typeof contributionStatusSchema> }
  | { type: "contribution_person_added" | "contribution_person_removed"; areaId: string; personId: string }
  | { type: "agent_work_started"; until: string }
  | { type: "agent_work_ended"; reason: "agent" | "person" | "finished" | "idea" | "archived" }
  | { type: "idea_registered" | "idea_accepted" | "idea_discarded" | "idea_reopened" }
  | { type: "idea_stage_changed"; from: z.output<typeof ideaStageSchema>; to: z.output<typeof ideaStageSchema> }
  | { type: "comment"; comment: CommentRow };
/** Entrada ainda sem os ids resolvidos. `pos` é a posição na ordem total (instante, evento, campo). */
type Draft = { id: string; type: Data["type"]; actorId: string | null; occurredAt: number; pos: Position; data: Data; contributionId?: string; via?: "mcp"; automatic?: true };

const idOrNull = z.uuid().nullable();
const fromTo = <T extends z.ZodType>(schema: T) => z.object({ from: schema, to: schema });
const issueKey = /^[A-Za-z][A-Za-z0-9]*-(\d+)$/;
const isMcp = (payload: unknown): boolean => typeof payload === "object" && payload !== null && (payload as Record<string, unknown>)["via"] === "mcp";
const isAutomatic = (payload: unknown): boolean => typeof payload === "object" && payload !== null && (payload as Record<string, unknown>)["automatic"] === true;
const refOf = (id: string | null): RefDraft | null => (id === null ? null : { id, key: null, number: null });

function compare(a: Position, b: Position): number {
  return a.t - b.t || (a.e < b.e ? -1 : a.e > b.e ? 1 : 0) || a.s - b.s;
}

export function encodeCursor(pos: Position): string {
  return Buffer.from(JSON.stringify(pos), "utf8").toString("base64url");
}

/**
 * O cursor, conferido inteiro por esquema estrito (revisão de segurança, TREEPM-495): instante que o PostgreSQL aceita (anos 1 a 9999),
 * id de evento ou de comentário e posição pequena. Fora disso é entrada inválida, nunca uma falha do banco.
 */
const cursorSchema = z
  .object({
    t: z.number().int().min(-62_135_596_800_000).max(253_402_300_799_999),
    e: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
    s: z.number().int().min(0).max(10_000),
  })
  .strict();

/** O cursor decodificado, ou `null` quando não vale. A leitura do MCP confere o cursor da tela que leva dentro do dela por aqui. */
export function parseActivityCursor(raw: string): Position | null {
  try {
    const parsed = cursorSchema.safeParse(JSON.parse(Buffer.from(raw, "base64url").toString("utf8")));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

function decodeCursor(raw: string): Position {
  const cursor = parseActivityCursor(raw);
  if (cursor === null) throw new BadRequestException({ code: "validation_error", message: "Entrada inválida: before." });
  return cursor;
}

/** Entradas de um evento, da mais nova para a mais antiga; payload fora do esperado só descarta a entrada. */
function draftsOf(row: { id: string; kind: string; actorPersonId: string | null; occurredAt: Date; payload: unknown }): Draft[] {
  const t = row.occurredAt.getTime();
  const make = (sub: number, id: string, data: Data, contributionId?: string): Draft => ({
    id,
    type: data.type,
    actorId: row.actorPersonId,
    occurredAt: t,
    pos: { t, e: row.id, s: sub },
    data,
    ...(contributionId === undefined ? {} : { contributionId }),
    ...(isMcp(row.payload) ? { via: "mcp" as const } : {}),
    ...(row.kind === "ticket.updated" && isAutomatic(row.payload) ? { automatic: true as const } : {}),
  });
  const payload = row.payload;
  if (row.kind === "ticket.created") return [make(0, row.id, { type: "created" })];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return [];
  const p = payload as Record<string, unknown>;
  switch (row.kind) {
    case "ticket.updated": {
      const fields = z.array(z.string()).safeParse(p["fields"]);
      if (!fields.success) return [];
      const out: Draft[] = [];
      FIELD_ORDER.forEach((field, index) => {
        if (!fields.data.includes(field)) return;
        const id = `${row.id}:${field === "parentId" ? "parent" : field}`;
        if (field === "description") return void out.push(make(index, id, { type: "description_changed" }));
        if (field === "title") {
          const v = fromTo(z.string()).safeParse(p["title"]);
          if (v.success) out.push(make(index, id, { type: "title_changed", from: v.data.from, to: v.data.to }));
        } else if (field === "status") {
          const v = fromTo(ticketStatusSchema).safeParse(p["status"]);
          const automatic = z.boolean().optional().safeParse(p["automatic"]);
          const caused = z.string().min(1).max(100).nullish().safeParse(p["causedBy"]);
          if (!v.success || !automatic.success || !caused.success) return;
          const key = caused.data ?? null;
          const number = key === null ? null : Number(issueKey.exec(key)?.[1] ?? NaN);
          const causedBy = key === null ? null : { id: null, key, number: Number.isSafeInteger(number) ? number : null };
          out.push(make(index, id, { type: "status_changed", from: v.data.from, to: v.data.to, automatic: automatic.data ?? false, causedBy }));
        } else if (field === "priority") {
          const v = fromTo(z.number().int()).safeParse(p["priority"]);
          if (v.success) out.push(make(index, id, { type: "priority_changed", from: v.data.from, to: v.data.to }));
        } else {
          const v = fromTo(idOrNull).safeParse(p["parentId"]);
          if (v.success) out.push(make(index, id, { type: "parent_changed", from: refOf(v.data.from), to: refOf(v.data.to) }));
        }
      });
      // Troca de responsáveis dentro de um `ticket.updated` (a reimportação do Linear): as mesmas entradas de `ticket.assignee_added/removed`.
      if (fields.data.includes("assignees")) {
        const v = fromTo(z.array(z.uuid())).safeParse(p["assignees"]);
        if (v.success) {
          const added = v.data.to.filter((id) => !v.data.from.includes(id));
          const removed = v.data.from.filter((id) => !v.data.to.includes(id));
          added.forEach((personId, k) => out.push(make(FIELD_ORDER.length + k, `${row.id}:assignee_added:${personId}`, { type: "assignee_added", personId })));
          removed.forEach((personId, k) => out.push(make(FIELD_ORDER.length + added.length + k, `${row.id}:assignee_removed:${personId}`, { type: "assignee_removed", personId })));
        }
      }
      return out.reverse();
    }
    case "ticket.assignee_added":
    case "ticket.assignee_removed": {
      const v = z.uuid().safeParse(p["personId"]);
      return v.success ? [make(0, row.id, { type: row.kind === "ticket.assignee_added" ? "assignee_added" : "assignee_removed", personId: v.data })] : [];
    }
    case "ticket.dependency_added":
    case "ticket.dependency_removed": {
      const v = z.object({ dependsOnTicketId: z.uuid(), dependsOnKey: z.string().max(100).optional() }).safeParse(p);
      if (!v.success) return [];
      const type = row.kind === "ticket.dependency_added" ? "dependency_added" : "dependency_removed";
      return [make(0, row.id, { type, ticket: { id: v.data.dependsOnTicketId, key: v.data.dependsOnKey ?? null, number: null } })];
    }
    case "ticket.agent_work_started": {
      const v = z.object({ until: z.string().datetime() }).safeParse(p);
      return v.success ? [make(0, row.id, { type: "agent_work_started", until: v.data.until })] : [];
    }
    case "ticket.agent_work_ended": {
      const v = z.object({ reason: z.enum(["agent", "person", "finished", "idea", "archived"]) }).safeParse(p);
      return v.success ? [make(0, row.id, { type: "agent_work_ended", reason: v.data.reason })] : [];
    }
    case "ticket.idea_registered":
      return [make(0, row.id, { type: "idea_registered" })];
    case "ticket.idea_accepted":
      return [make(0, row.id, { type: "idea_accepted" })];
    case "ticket.idea_discarded":
      return [make(0, row.id, { type: "idea_discarded" })];
    case "ticket.idea_reopened":
      return [make(0, row.id, { type: "idea_reopened" })];
    case "ticket.idea_stage_changed": {
      const v = fromTo(ideaStageSchema).safeParse(p);
      return v.success ? [make(0, row.id, { type: "idea_stage_changed", from: v.data.from, to: v.data.to })] : [];
    }
    case "ticket.summary_updated": {
      const v = z.enum(["person", "assistant"]).safeParse(p["source"]);
      return v.success ? [make(0, row.id, { type: "summary_updated", source: v.data })] : [];
    }
    case "ticket.contribution_added": {
      const v = contributionRef.safeParse(p);
      return v.success ? [make(0, row.id, { type: "contribution_added", areaId: v.data.areaId })] : [];
    }
    case "ticket.contribution_removed": {
      const v = contributionRef.extend({ areaName: z.string().max(500).nullish() }).safeParse(p);
      return v.success ? [make(0, row.id, { type: "contribution_removed", areaId: v.data.areaId, areaName: v.data.areaName ?? null })] : [];
    }
    case "ticket.contribution_person_added":
    case "ticket.contribution_person_removed": {
      const v = contributionRef.extend({ personId: z.uuid() }).safeParse(p);
      if (!v.success) return [];
      const type = row.kind === "ticket.contribution_person_added" ? "contribution_person_added" : "contribution_person_removed";
      return [make(0, row.id, { type, areaId: v.data.areaId, personId: v.data.personId })];
    }
    case "ticket.contribution_updated": {
      const v = contributionRef.extend({ fields: z.array(z.string()) }).safeParse(p);
      if (!v.success) return [];
      const out: Draft[] = [];
      CONTRIBUTION_FIELD_ORDER.forEach((field, index) => {
        if (!v.data.fields.includes(field)) return;
        const id = `${row.id}:${field}`;
        if (field === "text") return void out.push(make(index, id, { type: "contribution_text_changed", areaId: v.data.areaId }, v.data.contributionId));
        const status = fromTo(contributionStatusSchema).safeParse(p["status"]);
        if (status.success) out.push(make(index, id, { type: "contribution_status_changed", areaId: v.data.areaId, from: status.data.from, to: status.data.to }, v.data.contributionId));
      });
      return out.reverse();
    }
    default:
      return [];
  }
}

type TicketForFeed = { id: string; createdByPersonId: string; createdAt: Date };

/** Uma das duas fontes de entradas. `after` é de onde buscar a seguir (mais antigo); `edge` é a última linha lida. */
type Stream = { exhausted: boolean; after: { t: number; e: string } | null; inclusive: boolean; edge: Position | null };

/**
 * Atividade de um ticket (ADR 0040): mudanças (fatia 1) e comentários (fatia 2), intercalados. Só lê.
 * Consultas, em número constante: as de quem chama para achar o ticket e o projeto, mais, aqui, uma de eventos, uma de
 * comentários, uma de tickets citados, uma de pessoas e uma de áreas (estas três só quando há o que resolver, e em paralelo).
 * Só crescem se a página exigir mais lotes (muitas edições da descrição ou eventos ignorados no caminho) ou, em páginas
 * seguintes de ticket sem evento de criação visto, por uma conferência de "tem evento de criação".
 */
@Injectable()
export class TicketActivityService {
  async read(tx: TenantClient, project: ProjectRow, ticket: TicketForFeed, query: { limit: number; before?: string | undefined; contribution?: string | undefined }, viewer: Viewer): Promise<ActivityPage> {
    const cursor = query.before === undefined ? null : decodeCursor(query.before);
    const { limit } = query;
    const start = cursor === null ? null : { t: cursor.t, e: cursor.e };

    // O corte é sempre entre entradas já fechadas: busca lotes das duas fontes até haver uma entrada além do limite (ela
    // prova que a anterior não cresce mais) ou até acabarem as duas. Uma entrada só vale quando nenhuma fonte ainda
    // aberta pode ter algo entre ela e a anterior: tudo acima da última linha lida de cada fonte aberta está completo.
    // Assim a junção das edições dá o mesmo resultado qualquer que seja o limite, e o cursor (posição da entrada mais
    // antiga devolvida) cai sempre entre grupos.
    // Com `contribution`, só os comentários daquela contribuição: nenhuma mudança e nenhuma entrada "created" sintética.
    const only = query.contribution;
    const events: Stream = { exhausted: only !== undefined, after: start, inclusive: true, edge: null };
    const comments: Stream = { exhausted: false, after: start, inclusive: true, edge: null };
    let drafts: Draft[] = [];
    let seenCreated = false;
    let synthesized = false;
    let merged: MergedEntry<Draft>[] = [];
    let take = limit + FIRST_BATCH_EXTRA;
    while (!(events.exhausted && comments.exhausted) && merged.length <= limit) {
      const [eventRows, commentRows] = await Promise.all([
        events.exhausted ? [] : this.eventBatch(tx, ticket.id, events, take),
        comments.exhausted ? [] : this.commentBatch(tx, ticket.id, comments, take, only),
      ]);
      if (!events.exhausted) {
        events.exhausted = eventRows.length < take;
        for (const row of eventRows) {
          if (row.kind === "ticket.created") seenCreated = true;
          for (const draft of draftsOf(row)) if (cursor === null || compare(draft.pos, cursor) < 0) drafts.push(draft);
        }
        const last = eventRows[eventRows.length - 1];
        if (last) {
          events.after = { t: last.occurredAt.getTime(), e: last.id };
          events.edge = { t: last.occurredAt.getTime(), e: last.id, s: -1 };
        }
        events.inclusive = false;
      }
      if (!comments.exhausted) {
        comments.exhausted = commentRows.length < take;
        for (const row of commentRows) {
          const pos = { t: row.createdAt.getTime(), e: row.id, s: 0 };
          if (cursor === null || compare(pos, cursor) < 0) drafts.push({ id: row.id, type: "comment", actorId: row.authorPersonId, occurredAt: pos.t, pos, data: { type: "comment", comment: row } });
        }
        const last = commentRows[commentRows.length - 1];
        if (last) {
          comments.after = { t: last.createdAt.getTime(), e: last.id };
          comments.edge = { t: last.createdAt.getTime(), e: last.id, s: -1 };
        }
        comments.inclusive = false;
      }
      take = Math.min(MAX_BATCH, take * 2);
      if (only === undefined && events.exhausted && !synthesized && !seenCreated && !(await this.hasCreatedEvent(tx, ticket.id, cursor !== null))) {
        const t = ticket.createdAt.getTime();
        drafts = [...drafts, { id: `created:${ticket.id}`, type: "created", actorId: ticket.createdByPersonId, occurredAt: t, pos: { t: -1, e: SYNTHETIC_ID, s: -1 }, data: { type: "created" } }];
        synthesized = true;
      }
      const floor = [events, comments].filter((stream) => !stream.exhausted).reduce<Position | null>((top, stream) => (stream.edge && (top === null || compare(stream.edge, top) > 0) ? stream.edge : top), null);
      const closed = floor === null ? drafts : drafts.filter((draft) => compare(draft.pos, floor) >= 0);
      merged = mergeDescriptionEdits(closed.sort((a, b) => compare(b.pos, a.pos)));
    }

    const shown = merged.slice(0, limit);
    const more = merged.length > limit;
    const entries = shown.map(({ entry, oldest }) => ({ ...entry, id: oldest.id }));
    const lastShown = shown[shown.length - 1];
    const before = more && lastShown ? encodeCursor(lastShown.oldest.pos) : null;
    // A conversa de uma área (`contribution`) segue a regra de comentar numa área: o leitor comenta no ticket, não nela.
    const canComment = project.archivedAt === null && canCommentTicket(viewer.actor, project.id) && (only === undefined || canEditContributions(viewer.actor, project.id));
    return parseOutput(activityPageSchema, { entries: await this.resolve(tx, project, entries, viewer), before, canComment });
  }

  private eventBatch(tx: TenantClient, ticketId: string, stream: Stream, take: number) {
    const { after, inclusive } = stream;
    return tx.activityEvent.findMany({
      where: {
        subjectType: "ticket",
        subjectId: ticketId,
        kind: { in: READ_KINDS },
        ...(after === null ? {} : { OR: [{ occurredAt: { lt: new Date(after.t) } }, { occurredAt: new Date(after.t), id: inclusive ? { lte: after.e } : { lt: after.e } }] }),
      },
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take,
      select: { id: true, kind: true, actorPersonId: true, occurredAt: true, payload: true },
    });
  }

  private commentBatch(tx: TenantClient, ticketId: string, stream: Stream, take: number, contributionId?: string) {
    const { after, inclusive } = stream;
    return tx.ticketComment.findMany({
      where: {
        ticketId,
        ...(contributionId === undefined ? {} : { contributionId }),
        ...(after === null ? {} : { OR: [{ createdAt: { lt: new Date(after.t) } }, { createdAt: new Date(after.t), id: inclusive ? { lte: after.e } : { lt: after.e } }] }),
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take,
      select: commentSelect,
    });
  }

  /** Só vale perguntar quando há cursor: na primeira página, "não visto" já significa "não existe". */
  private async hasCreatedEvent(tx: TenantClient, ticketId: string, ask: boolean): Promise<boolean> {
    if (!ask) return false;
    return (await tx.activityEvent.count({ where: { subjectType: "ticket", subjectId: ticketId, kind: "ticket.created" }, take: 1 })) > 0;
  }

  private async resolve(tx: TenantClient, project: ProjectRow, drafts: Draft[], viewer: Viewer): Promise<ActivityEntry[]> {
    const personIds = new Set<string>();
    const ticketIds = new Set<string>();
    const numbers = new Set<number>();
    const areaIds = new Set<string>();
    const refs = (d: Draft): (RefDraft | null)[] => {
      const data = d.data;
      if (data.type === "status_changed") return [data.causedBy];
      if (data.type === "parent_changed") return [data.from, data.to];
      if (data.type === "dependency_added" || data.type === "dependency_removed") return [data.ticket];
      return [];
    };
    for (const d of drafts) {
      if (d.actorId) personIds.add(d.actorId);
      if (d.data.type === "assignee_added" || d.data.type === "assignee_removed") personIds.add(d.data.personId);
      if (d.data.type === "contribution_person_added" || d.data.type === "contribution_person_removed") personIds.add(d.data.personId);
      if ("areaId" in d.data) areaIds.add(d.data.areaId);
      for (const ref of refs(d)) {
        if (ref?.id) ticketIds.add(ref.id);
        if (ref?.number != null) numbers.add(ref.number);
      }
    }
    const [people, tickets, areas] = await Promise.all([
      personIds.size === 0 ? [] : tx.person.findMany({ where: { id: { in: [...personIds] } }, select: { id: true, displayName: true, avatarUrl: true } }),
      ticketIds.size === 0 && numbers.size === 0
        ? []
        : tx.ticket.findMany({
            where: {
              projectId: project.id,
              OR: [...(ticketIds.size > 0 ? [{ id: { in: [...ticketIds] } }] : []), ...(numbers.size > 0 ? [{ number: { in: [...numbers] } }] : [])],
            },
            select: { id: true, number: true, title: true },
          }),
      areaIds.size === 0 ? [] : tx.area.findMany({ where: { id: { in: [...areaIds] } }, select: { id: true, name: true } }),
    ]);
    const areaById = new Map(areas.map((a) => [a.id, a]));
    const areaRef = (id: string, storedName: string | null = null) => {
      const found = areaById.get(id);
      return found ? { id: found.id, name: found.name } : storedName === null ? null : { id, name: storedName };
    };
    const personById = new Map(people.map((p) => [p.id, { id: p.id, displayName: p.displayName, avatarUrl: p.avatarUrl }]));
    const byId = new Map(tickets.map((x) => [x.id, x]));
    const byNumber = new Map(tickets.map((x) => [x.number, x]));
    const ticketRef = (ref: RefDraft) => {
      const found = ref.id ? byId.get(ref.id) : ref.number != null ? byNumber.get(ref.number) : undefined;
      return found ? { id: found.id, key: `${project.key}-${found.number}`, title: found.title } : { id: null, key: ref.key, title: null };
    };
    const person = (id: string | null) => (id ? (personById.get(id) ?? null) : null);

    return drafts.map((d): ActivityEntry => {
      const common = { id: d.id, occurredAt: new Date(d.occurredAt).toISOString(), actor: person(d.actorId), ...(d.via ? { via: d.via } : {}), ...(d.automatic ? { automatic: true as const } : {}) };
      const data = d.data;
      switch (data.type) {
        case "created":
        case "description_changed":
        case "idea_registered":
        case "idea_accepted":
        case "idea_discarded":
        case "idea_reopened":
          return { ...common, type: data.type };
        case "agent_work_started":
          return { ...common, type: data.type, until: data.until };
        case "agent_work_ended":
          return { ...common, type: data.type, reason: data.reason };
        case "idea_stage_changed":
          return { ...common, type: data.type, from: data.from, to: data.to };
        case "title_changed":
          return { ...common, type: data.type, from: data.from, to: data.to };
        case "priority_changed":
          return { ...common, type: data.type, from: data.from, to: data.to };
        case "status_changed":
          return { ...common, type: data.type, from: data.from, to: data.to, automatic: data.automatic, causedBy: data.causedBy ? ticketRef(data.causedBy) : null };
        case "parent_changed":
          return { ...common, type: data.type, from: data.from ? ticketRef(data.from) : null, to: data.to ? ticketRef(data.to) : null };
        case "assignee_added":
        case "assignee_removed":
          return { ...common, type: data.type, person: person(data.personId) };
        case "dependency_added":
        case "dependency_removed":
          return { ...common, type: data.type, ticket: ticketRef(data.ticket) };
        case "summary_updated":
          return { ...common, type: data.type, source: data.source };
        case "contribution_added":
        case "contribution_text_changed":
          return { ...common, type: data.type, area: areaRef(data.areaId) };
        case "contribution_removed":
          return { ...common, type: data.type, area: areaRef(data.areaId, data.areaName) };
        case "contribution_status_changed":
          return { ...common, type: data.type, area: areaRef(data.areaId), from: data.from, to: data.to };
        case "contribution_person_added":
        case "contribution_person_removed":
          return { ...common, type: data.type, area: areaRef(data.areaId), person: person(data.personId) };
        case "comment":
          return toCommentEntry(data.comment, common.actor, commentRights(viewer, project, data.comment));
      }
    });
  }
}
