import type { TFunction } from "i18next";
import type { TicketStatus } from "../api/client.js";

/** A situação de um pai sai dos filhos (ADR 0068): o ticket concluído que ganha um filho aberto deixa de estar concluído. */
export const reopensOnReceiving = (parent: { status: TicketStatus } | null | undefined): boolean => parent?.status === "done";

/** Aviso antes de confirmar, no idioma ativo (catálogo `ticket`). */
export const reopenWarningText = (t: TFunction<"ticket">, key: string): string => t("reopen.warning", { key });

/** Aviso depois do fato, no idioma ativo (catálogo `ticket`). */
export const reopenedNoticeText = (t: TFunction<"ticket">, key: string): string => t("reopen.notice", { key });

/** Finalizado é `done` ou `cancelled`; aberto é qualquer outra situação. */
export const isOpenStatus = (status: TicketStatus): boolean => status !== "done" && status !== "cancelled";
