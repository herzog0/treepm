/** Montagem pura das requisições da coleta: a pergunta da coleta B e a mensagem da coleta D (e a validação do ranking). */
import { noul } from "@typesafe-ai/sdk";
import { createHash } from "node:crypto";
import { descriptionExcerpt } from "@treepm/domain";
import { z } from "zod";
import type { GabaritoTicket } from "./core.js";
import { DEFINITION_SYSTEM_PROMPT } from "./collect-texts.js";
import { JEV_MODEL, JEV_SCOPE_FALSE, JEV_SCOPE_QUESTION, JEV_SCOPE_TRUE } from "../../src/assistant/prompts.js";

export const ROOT_OPTION = "root";
export const MAX_RANKING = 3;

export type OutlineGroup = { id: string; title: string; description: string; tickets: readonly string[] };

/**
 * A mensagem do usuário da coleta D. As opções `g1…gN` seguem a ordem recebida (quem chama manda os agrupadores na
 * ordem do número); `optionIds[i]` é o id que `g{i+1}` representa. Nenhum id sai na mensagem.
 */
export function buildClaudeProject(input: {
  projectName: string;
  groups: readonly OutlineGroup[];
  /** Coleta D−: o agrupador original do ticket não entra no esboço. */
  excludeGroupId: string | null;
  newTicket: { title: string; description: string };
}): { content: string; optionIds: string[] } {
  const listed = input.groups.filter((group) => group.id !== input.excludeGroupId);
  const content = {
    project: {
      name: input.projectName,
      groups: listed.map((group, index) => ({
        option: `g${index + 1}`,
        title: group.title,
        ...(group.description === "" ? {} : { description: group.description }),
        tickets: [...group.tickets],
      })),
    },
    new_ticket: { title: input.newTicket.title, ...(input.newTicket.description === "" ? {} : { description: input.newTicket.description }) },
  };
  return { content: JSON.stringify(content), optionIds: listed.map((group) => group.id) };
}

/** A saída estruturada pedida ao Claude; o limite de itens é conferido em `validateRanking`, não no esquema. */
export const rankingFormat = z.object({ ranking: z.array(z.string()).describe("De uma a três opções, da mais adequada para a menos adequada.") });

export type RankingCheck = { ok: true; ranking: string[] } | { ok: false; reason: string };

/** Traduz o ranking para ids (ou `root`); saída fora do combinado é recusada com o motivo (nunca derruba a coleta). */
export function validateRanking(output: unknown, optionIds: readonly string[]): RankingCheck {
  const parsed = rankingFormat.safeParse(output);
  if (!parsed.success) return { ok: false, reason: "forma inesperada" };
  const { ranking } = parsed.data;
  if (ranking.length === 0) return { ok: false, reason: "ranking vazio" };
  if (ranking.length > MAX_RANKING) return { ok: false, reason: `mais de ${MAX_RANKING} itens` };
  if (new Set(ranking).size !== ranking.length) return { ok: false, reason: "opção repetida" };
  const ids: string[] = [];
  for (const option of ranking) {
    if (option === ROOT_OPTION) {
      ids.push(ROOT_OPTION);
      continue;
    }
    const match = /^g([1-9]\d*)$/.exec(option);
    const id = match ? optionIds[Number(match[1]) - 1] : undefined;
    if (id === undefined) return { ok: false, reason: `opção inexistente: ${option}` };
    ids.push(id);
  }
  return { ok: true, ranking: ids };
}

/**
 * Coleta B: uma requisição com o rascunho no estado e uma pergunta Noul por agrupador. O agrupador vai como dado
 * nomeado `scope` nas `instructions` da pergunta (como a afinidade leva `ticket`); a chave liga a resposta ao agrupador.
 */
export function buildFitRequest(
  draft: { title: string; description: string },
  groups: readonly { id: string; title: string; summary: string }[],
) {
  const keys = groups.map((group, index) => ({ key: `group_${index + 1}`, id: group.id, group }));
  const state = { draft: { title: draft.title, ...(draft.description === "" ? {} : { description: draft.description }) } };
  const questions = Object.fromEntries(
    keys.map(({ key, group }) => [
      key,
      noul(
        { question: JEV_SCOPE_QUESTION, scope: group.summary === "" ? { title: group.title } : { title: group.title, summary: group.summary } },
        { true: JEV_SCOPE_TRUE, false: JEV_SCOPE_FALSE },
      ),
    ]),
  );
  return { request: { model: JEV_MODEL, state, questions }, keys: keys.map(({ key, id }) => ({ key, id })) };
}

/** O esboço do projeto para o Claude a partir do gabarito: agrupadores da raiz na ordem do número, com os tickets diretos na ordem do número, sem o ticket de fora. */
export function buildOutline(gabarito: readonly GabaritoTicket[], leftOutId: string): OutlineGroup[] {
  const byNumber = (a: GabaritoTicket, b: GabaritoTicket): number => a.number - b.number;
  return gabarito
    .filter((t) => t.kind === "group" && t.parentId === null)
    .sort(byNumber)
    .map((group) => ({
      id: group.id,
      title: group.title,
      description: group.description,
      tickets: gabarito
        .filter((t) => t.kind === "ticket" && t.parentId === group.id && t.id !== leftOutId)
        .sort(byNumber)
        .map((t) => t.title),
    }));
}

export type DefinitionInput = { group: { title: string; description?: string; items: string[] }; siblings: string[] };

/**
 * As entradas das definições de um ticket que sai do projeto (sem vazamento). Positivo: a do agrupador original é
 * escrita sem o ticket em `items`; os irmãos são os outros agrupadores da raiz. Negativo: só os agrupadores restantes,
 * e o título do original não entra em nenhuma entrada (nem nos irmãos).
 */
export function definitionInputs(
  gabarito: readonly GabaritoTicket[],
  ticketId: string,
): { originalGroupId: string | null; positive: Record<string, DefinitionInput>; negative: Record<string, DefinitionInput> | null } {
  const byNumber = (a: GabaritoTicket, b: GabaritoTicket): number => a.number - b.number;
  const byId = new Map(gabarito.map((t) => [t.id, t]));
  const ticket = byId.get(ticketId);
  let originalGroupId: string | null = null;
  if (ticket && ticket.parentId !== null) {
    let cursor: GabaritoTicket = ticket;
    while (cursor.parentId !== null) cursor = byId.get(cursor.parentId) as GabaritoTicket;
    originalGroupId = cursor.id;
  }
  const roots = gabarito.filter((t) => t.kind === "group" && t.parentId === null).sort(byNumber);
  const inputOf = (group: GabaritoTicket, siblings: readonly GabaritoTicket[]): DefinitionInput => {
    const excerpt = descriptionExcerpt(group.description);
    return {
      group: {
        title: group.title,
        ...(excerpt === "" ? {} : { description: excerpt }),
        items: gabarito.filter((t) => t.parentId === group.id && t.id !== ticketId).sort(byNumber).map((t) => t.title),
      },
      siblings: siblings.map((s) => s.title),
    };
  };
  const positive = Object.fromEntries(roots.map((g) => [g.id, inputOf(g, roots.filter((o) => o.id !== g.id))]));
  const remaining = roots.filter((g) => g.id !== originalGroupId);
  const negative =
    originalGroupId === null || remaining.length === 0
      ? null
      : Object.fromEntries(remaining.map((g) => [g.id, inputOf(g, remaining.filter((o) => o.id !== g.id))]));
  return { originalGroupId, positive, negative };
}

/** A mensagem do usuário da definição (JSON, na ordem `group` e `siblings`). */
export const definitionMessage = (input: DefinitionInput): string =>
  JSON.stringify({
    group: { title: input.group.title, ...(input.group.description === undefined ? {} : { description: input.group.description }), items: input.group.items },
    siblings: input.siblings,
  });

/** A chave do cache vem do conteúdo da entrada e do texto que a escreve (mudar o prompt invalida o cache). */
export const definitionKey = (input: DefinitionInput): string =>
  createHash("sha256").update(DEFINITION_SYSTEM_PROMPT).update("\0").update(definitionMessage(input)).digest("hex");

export const definitionFormat = z.object({ definition: z.string().describe("A definição do agrupador, em duas frases.") });
export const MAX_DEFINITION_CHARS = 600;

export type DefinitionCheck = { ok: true; definition: string } | { ok: false; reason: string };

/** Definição vazia, com mais de 600 caracteres ou sem as duas marcas é inválida (o ticket usa o resumo do produto). */
export function validateDefinition(output: unknown): DefinitionCheck {
  const parsed = definitionFormat.safeParse(output);
  if (!parsed.success) return { ok: false, reason: "forma inesperada" };
  const definition = parsed.data.definition.trim();
  if (definition === "") return { ok: false, reason: "vazia" };
  if (definition.length > MAX_DEFINITION_CHARS) return { ok: false, reason: `mais de ${MAX_DEFINITION_CHARS} caracteres` };
  if (!definition.includes("Entra aqui:") || !definition.includes("Não entra aqui:")) return { ok: false, reason: "faltam as marcas" };
  return { ok: true, definition };
}
