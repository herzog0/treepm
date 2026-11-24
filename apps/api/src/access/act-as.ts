import { ForbiddenException } from "@nestjs/common";
import type { Principal } from "./principal.js";

/** Cabeçalho de "entrar como" (ADR 0057): o id da pessoa de teste que o administrador quer ser nesta requisição. */
export const ACT_AS_HEADER = "x-treepm-act-as";

/** Prefixo do identificador do Clerk de uma pessoa de teste: nunca é um identificador de verdade (os do Clerk começam por `user_`). */
export const TEST_PERSON_PREFIX = "treepm_test_";

/** Máximo de pessoas de teste ativas por organização. */
export const TEST_PEOPLE_LIMIT = 20;

/** Máximo de pessoas de teste por organização, ativas e inativas (a pessoa de teste é desativada, nunca apagada). */
export const TEST_PEOPLE_TOTAL_LIMIT = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O que a requisição pediu: nada, ou um id (`null` quando o cabeçalho veio mal formado, vazio ou repetido). */
export type ActAsRequest = { requested: false } | { requested: true; personId: string | null };

/** Lê o cabeçalho cru. Presente-mas-inválido é um pedido (que será recusado), nunca "ausente": nada é ignorado em silêncio. */
export function readActAs(headers: Record<string, string | string[] | undefined>): ActAsRequest {
  const raw = headers[ACT_AS_HEADER];
  if (raw === undefined) return { requested: false };
  return { requested: true, personId: typeof raw === "string" && UUID.test(raw) ? raw.toLowerCase() : null };
}

/** A recusa única do "entrar como": o mesmo corpo para todos os motivos, para a resposta não revelar quem existe nem o que é de teste. */
export function actAsNotAllowed(): ForbiddenException {
  return new ForbiddenException({ code: "act_as_not_allowed", message: "Não é possível agir como essa pessoa." });
}

/** Ações que não valem enquanto se age como outra pessoa: chaves de acesso e rotas de pessoa de teste. */
export function refuseWhileActingAs(principal: Principal): void {
  if (principal.via?.kind === "act-as") {
    throw new ForbiddenException({ code: "not_while_acting_as", message: "Volte a ser você para fazer isto." });
  }
}
