import type { TFunction } from "i18next";

/** "agora", "há 2 minutos", "há 1 hora", "há 3 dias" no idioma ativo (catálogo `github`, `code.relative.*`). */
export function relativeTimeText(t: TFunction<"github">, iso: string, now: number = Date.now()): string {
  const seconds = Math.max(0, Math.round((now - new Date(iso).getTime()) / 1000));
  if (seconds < 60) return t("code.relative.now");
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("code.relative.minutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("code.relative.hours", { count: hours });
  return t("code.relative.days", { count: Math.floor(hours / 24) });
}
