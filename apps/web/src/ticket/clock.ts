import { createContext, useContext } from "react";

/**
 * O relógio da página do ticket (ADR 0064): quem decide "hoje" para o atraso do prazo. Fora dos testes é o relógio do
 * navegador; os testes e as capturas trocam pelo provedor.
 */
export const ClockContext = createContext<() => Date>(() => new Date());

/** O dia `AAAA-MM-DD` de uma data no fuso do navegador (ano, mês e dia locais; nunca `toISOString`, que é UTC). */
export function localDay(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** "Hoje" no fuso do navegador, pelo relógio da página. */
export function useLocalToday(): string {
  return localDay(useContext(ClockContext)());
}
