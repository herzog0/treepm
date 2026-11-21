const DATE = new Intl.DateTimeFormat("pt-BR", { day: "numeric", month: "long", year: "numeric" });

/** "20 de novembro de 2026". */
export const formatDate = (iso: string): string => DATE.format(new Date(iso));

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`;

/** "agora", "há 2 minutos", "há 1 hora", "há 3 dias" — para a linha "Atualizado …". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return "agora";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `há ${count(minutes, "minuto", "minutos")}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `há ${count(hours, "hora", "horas")}`;
  return `há ${count(Math.floor(hours / 24), "dia", "dias")}`;
}
