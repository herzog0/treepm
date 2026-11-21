/** Montagem pura das requisições da coleta: a pergunta da coleta B e a mensagem da coleta D (e a validação do ranking). */
import { noul } from "@typesafe-ai/sdk";
import { z } from "zod";
import type { GabaritoTicket } from "./core.js";
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
