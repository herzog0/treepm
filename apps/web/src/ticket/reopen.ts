import type { TicketStatus } from "../api/client.js";

/** Reabertura (ADR 0034): a API leva o ticket concluído que ganha um filho aberto de volta para "a fazer". */
export const reopensOnReceiving = (parent: { status: TicketStatus } | null | undefined): boolean => parent?.status === "done";

/** Aviso antes de confirmar: o destino concluído volta para "A fazer" ao receber o ticket. */
export const reopenWarning = (key: string) => `«${key}» está concluído e volta para "A fazer" ao receber este ticket.`;

/** Aviso depois do fato, quando a escolha já foi aplicada no clique. */
export const reopenedNotice = (key: string) => `«${key}» estava concluído e voltou para "A fazer".`;

/** Finalizado é `done` ou `cancelled`; aberto é qualquer outra situação. */
export const isOpenStatus = (status: TicketStatus): boolean => status !== "done" && status !== "cancelled";
