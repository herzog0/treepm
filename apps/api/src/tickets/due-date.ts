/**
 * O prazo do ticket (ADR 0064) entre o banco e a API. A coluna é `date` (sem hora e sem fuso); o Prisma a lê e grava como a
 * meia-noite UTC do dia. Estas duas funções são a ÚNICA conversão: só UTC, nunca o fuso do processo (`toISOString` e o sufixo `Z`).
 * As leituras em SQL cru usam `to_char(due_date, 'YYYY-MM-DD')` e não passam por `Date`.
 */

/** A data do banco (meia-noite UTC) como `AAAA-MM-DD`; `null` sem prazo. */
export function dueDateText(value: Date | null | undefined): string | null {
  return value ? value.toISOString().slice(0, 10) : null;
}

/** `AAAA-MM-DD` (já validado) como a data que o Prisma grava; `null` tira o prazo. */
export function dueDateValue(value: string | null): Date | null {
  return value === null ? null : new Date(`${value}T00:00:00.000Z`);
}
