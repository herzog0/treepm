/**
 * Prazo do ticket (ADR 0064): uma data de calendário `AAAA-MM-DD`, sem hora e sem fuso. Funções puras; nenhuma passa por `Date` com
 * fuso local (a conta de dias usa `Date.UTC` só sobre ano, mês e dia, que não depende do fuso do processo).
 */
import type { TicketStatus } from "./tickets.js";

/**
 * A faixa aceita: de 2000-01-01 a 2100-12-31. Cabe com folga qualquer prazo real de projeto (e as datas do Linear), e recusa os erros
 * de digitação que viram datas absurdas (`0202-12-12`, `20266-01-01`), que o seletor de data do navegador deixa passar.
 */
export const DUE_DATE_MIN = "2000-01-01";
export const DUE_DATE_MAX = "2100-12-31";

const SHAPE = /^(\d{4})-(\d{2})-(\d{2})$/;

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return [4, 6, 9, 11].includes(month) ? 30 : 31;
}

/** Texto `AAAA-MM-DD` de uma data que existe (não `2026-02-30`) e cai na faixa. */
export function isValidDueDate(value: string): boolean {
  if (typeof value !== "string") return false;
  const match = SHAPE.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return false;
  return value >= DUE_DATE_MIN && value <= DUE_DATE_MAX;
}

/** O valor como prazo, ou `null` quando não é um prazo válido (o que vem de fora: Linear, retratos guardados). */
export function parseDueDate(value: unknown): string | null {
  return typeof value === "string" && isValidDueDate(value) ? value : null;
}

/**
 * O que decide o atraso: o prazo, a categoria da situação, o dia de hoje (quem chama decide qual é) e se o ticket é ideia (a raiz,
 * em qualquer estágio, ou um ticket dentro dela).
 */
export type OverdueInput = { dueDate: string | null; category: TicketStatus; today: string; idea: boolean };

/**
 * Atrasado (ADR 0064, seção 2): tem prazo, o prazo é anterior a hoje e a categoria é "a fazer", "em andamento" ou "em revisão".
 * Concluído e cancelado nunca. Ideia também nunca: está fora do processo (ADR 0042), e o prazo dela é só uma data. Comparação de
 * texto: `AAAA-MM-DD` ordena como data.
 */
export function isOverdue({ dueDate, category, today, idea }: OverdueInput): boolean {
  if (dueDate === null || idea) return false;
  if (category !== "todo" && category !== "in_progress" && category !== "in_review") return false;
  return dueDate < today;
}

const dayNumber = (date: string): number => {
  const [year, month, day] = date.split("-").map(Number) as [number, number, number];
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
};

/** Há quantos dias o ticket está atrasado (1 = o prazo foi ontem); 0 quando não está atrasado. */
export function daysOverdue(input: OverdueInput): number {
  if (!isOverdue(input) || input.dueDate === null) return 0;
  return dayNumber(input.today) - dayNumber(input.dueDate);
}

/** O dia em UTC de um instante (o "hoje" do MCP, ADR 0064). */
export function utcToday(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}
