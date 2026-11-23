import { SetMetadata } from "@nestjs/common";
import { idSchema } from "../common/schemas.js";
import { structureBusy } from "./structure-lock.js";

/**
 * Fila em memória das mudanças de estrutura, ANTES de a transação abrir (ADR 0045, adendo 1). A trava consultiva do banco
 * continua sendo a regra de correção; esta fila só limita quantas conexões do pool um mesmo projeto ocupa: sem ela, cada mudança
 * de estrutura abria a transação, pegava uma das 10 conexões e esperava a trava, e dezenas de escritores deixavam o resto da API
 * sem conexão. Vale por instância da API (com mais de uma, cada uma tem a sua fila e a trava do banco vale entre elas).
 *
 * Por chave (o projeto, ou a organização quando o chamador só conhece o ticket): no máximo `limit` em voo, uma com a trava e
 * outra esperando por ela; os demais esperam aqui, na ordem de chegada, sem conexão. Quem espera mais de `waitMs` recebe o mesmo
 * 409 `structure_busy` de quando a espera pela trava estoura. Fica num objeto para os testes reduzirem os valores.
 */
export const structureQueue = { limit: 2, waitMs: 3000 };

interface Waiter {
  grant(): void;
}
interface Lane {
  active: number;
  waiting: Waiter[];
}
const lanes = new Map<string, Lane>();

/** Quantas chaves a fila guarda agora (o que fica vazio sai do mapa): para os testes conferirem que não há vazamento. */
export const structureQueueKeys = (): number => lanes.size;

/**
 * O cliente desistiu enquanto esperava na fila. Não é erro de verdade: o filtro de erros a ignora (a resposta já fechou).
 */
export class StructureQueueAborted extends Error {
  constructor() {
    super("Requisição abortada enquanto esperava na fila de estrutura.");
    this.name = "StructureQueueAborted";
  }
}
const abortedError = (): Error => new StructureQueueAborted();

/**
 * A chave da fila: SEMPRE organização + projeto (id em minúsculas), a mesma forma no HTTP e no MCP. Inclui a organização para quem
 * é de fora não ocupar as vagas de um projeto alheio só por saber o id. Id fora do formato: `undefined` (não entra na fila e
 * segue para a validação normal).
 */
export function structureKey(orgId: string, projectId: string | undefined): string | undefined {
  if (projectId === undefined || !idSchema.safeParse(projectId).success) return undefined;
  return `${orgId}:${projectId.toLowerCase()}`;
}

function acquire(key: string, signal: AbortSignal | undefined): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortedError());
  let lane = lanes.get(key);
  if (lane === undefined) {
    lane = { active: 0, waiting: [] };
    lanes.set(key, lane);
  }
  if (lane.active < structureQueue.limit && lane.waiting.length === 0) {
    lane.active += 1;
    return Promise.resolve();
  }
  const mine = lane;
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const leave = (error: unknown): void => {
      const at = mine.waiting.indexOf(waiter);
      if (at >= 0) mine.waiting.splice(at, 1);
      cleanup();
      drop(key, mine);
      reject(error);
    };
    const onAbort = (): void => leave(abortedError());
    const waiter: Waiter = {
      grant: () => {
        cleanup();
        resolve();
      },
    };
    const timer = setTimeout(() => leave(structureBusy()), structureQueue.waitMs);
    timer.unref(); // a espera não segura o encerramento do processo
    signal?.addEventListener("abort", onAbort, { once: true });
    mine.waiting.push(waiter);
  });
}

/** Apaga a chave quando ninguém a usa mais. */
function drop(key: string, lane: Lane): void {
  if (lane.active === 0 && lane.waiting.length === 0 && lanes.get(key) === lane) lanes.delete(key);
}

function release(key: string): void {
  const lane = lanes.get(key);
  if (lane === undefined) return;
  const next = lane.waiting.shift();
  if (next !== undefined) {
    next.grant(); // a vaga passa direto ao primeiro da espera: quem chega depois não fura a fila
    return;
  }
  lane.active -= 1;
  drop(key, lane);
}

/**
 * Roda `work` (a abertura da transação) com uma das vagas da chave. A vaga é devolvida sempre: sucesso, erro ou estouro. Só quem
 * ainda espera sai pelo aborto (`signal`) ou pelo prazo; quem já está em voo devolve a vaga quando `work` termina.
 */
export async function withStructureSlot<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  await acquire(key, signal);
  try {
    return await work();
  } finally {
    release(key);
  }
}

/** Como uma rota entra na fila (lido pelo `TenantInterceptor`). */
export interface StructureRoute {
  /**
   * De onde sai o projeto da chave (a chave é sempre organização + projeto): `project` = o `:projectId` da rota; `ticket` e
   * `conversation` = o `:id` da rota, e o projeto vem de uma leitura curta (RLS valendo) antes da fila. Ticket ou conversa que a
   * organização não enxerga não entra na fila e segue o caminho normal (404).
   */
  by: "project" | "ticket" | "conversation";
  /** Decide pela forma do pedido, antes de os pipes rodarem, se este pedido muda a estrutura; sem ela, sempre muda. */
  when?: (body: unknown) => boolean;
}
export const STRUCTURE_QUEUE = "treepm:structure-queue";
export const QueuesStructure = (route: StructureRoute): MethodDecorator => SetMetadata(STRUCTURE_QUEUE, route);

/** O campo `name` do corpo cru do pedido (`undefined` se o corpo não for um objeto). */
export function bodyField(body: unknown, name: string): unknown {
  return typeof body === "object" && body !== null ? (body as Record<string, unknown>)[name] : undefined;
}
