import type { TFunction } from "i18next";
import type { TicketStatus } from "../api/client.js";

/** Reabertura (ADR 0034): a API leva o ticket concluído que ganha um filho aberto de volta para "a fazer". */
export const reopensOnReceiving = (parent: { status: TicketStatus } | null | undefined): boolean => parent?.status === "done";

// i18n: substituída por `reopenWarningText`; removida na limpeza final (ainda usada por assistant/PathCard)
/** Aviso antes de confirmar: o destino concluído volta para "A fazer" ao receber o ticket. */
export const reopenWarning = (key: string) => `«${key}» está concluído e volta para "A fazer" ao receber este ticket.`;

// i18n: substituída por `reopenedNoticeText`; removida na limpeza final
/** Aviso depois do fato, quando a escolha já foi aplicada no clique. */
export const reopenedNotice = (key: string) => `«${key}» estava concluído e voltou para "A fazer".`;

/** Aviso antes de confirmar, no idioma ativo (catálogo `ticket`). */
export const reopenWarningText = (t: TFunction<"ticket">, key: string): string => t("reopen.warning", { key });

/** Aviso depois do fato, no idioma ativo (catálogo `ticket`). */
export const reopenedNoticeText = (t: TFunction<"ticket">, key: string): string => t("reopen.notice", { key });

/** Finalizado é `done` ou `cancelled`; aberto é qualquer outra situação. */
export const isOpenStatus = (status: TicketStatus): boolean => status !== "done" && status !== "cancelled";
