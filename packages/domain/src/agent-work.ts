import type { TicketStatus } from "./tickets.js";
import { isFinished } from "./tickets.js";

/**
 * Marcador de trabalho pela IA (ADR 0043): um sinal de que um agente está trabalhando num ticket agora. Não é uma situação.
 * Funções puras: quem chama passa o instante de agora (o relógio injetável da API), nunca o do sistema.
 */

export const AGENT_WORK_MIN_MINUTES = 5;
export const AGENT_WORK_MAX_MINUTES = 240;
export const AGENT_WORK_DEFAULT_MINUTES = 60;
export const AGENT_WORK_NOTE_MAX = 200;

/** O marcador vale enquanto o fim é futuro; passado o prazo ele deixa de valer sozinho. */
export function agentWorkIsValid(until: Date | null, now: number): boolean {
  return until !== null && until.getTime() > now;
}

/** Por que o marcador não pode ser ligado: ticket concluído ou cancelado, ou ideia (ou dentro de uma). `null` = pode. */
export function agentWorkRefusal(status: TicketStatus, outsideProcess: boolean): "finished" | "idea" | null {
  if (outsideProcess) return "idea";
  return isFinished(status) ? "finished" : null;
}

/** A duração pedida: inteiro de 5 a 240 minutos; 60 quando não vier. */
export function agentWorkWindow(minutes: number | undefined): { ok: true; minutes: number } | { ok: false } {
  if (minutes === undefined) return { ok: true, minutes: AGENT_WORK_DEFAULT_MINUTES };
  if (!Number.isInteger(minutes) || minutes < AGENT_WORK_MIN_MINUTES || minutes > AGENT_WORK_MAX_MINUTES) return { ok: false };
  return { ok: true, minutes };
}

export function agentWorkEnd(now: number, minutes: number): Date {
  return new Date(now + minutes * 60_000);
}

// eslint-disable-next-line no-control-regex -- é exatamente o que se quer recusar
const CONTROL = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]");

// Direção de texto e invisíveis: U+200B a U+200F, U+202A a U+202E, U+2060 a U+2069 e U+FEFF. Escondem ou invertem o que a pessoa lê.
const INVISIBLE = new RegExp("[\\u200b-\\u200f\\u202a-\\u202e\\u2060-\\u2069\\ufeff]");

/** A nota: aparada, de 0 a 200 caracteres, em uma linha só. Vazia é "sem nota" (`""`); `null` quando não vale. */
export function agentWorkNoteOf(raw: string | undefined): string | null {
  // Os invisíveis são conferidos no texto ORIGINAL: o `trim` já tiraria um U+FEFF das pontas em silêncio.
  if (raw !== undefined && INVISIBLE.test(raw)) return null;
  const note = (raw ?? "").trim();
  if (note.length > AGENT_WORK_NOTE_MAX || CONTROL.test(note)) return null;
  return note;
}
