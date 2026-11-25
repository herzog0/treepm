import type { TFunction } from "i18next";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { ApiError } from "./client.js";

/** Códigos de erro com frase própria no catálogo `api` (`errors.code.*`). */
const KNOWN_CODES = new Set([
  "team_name_taken", "area_name_taken", "project_key_taken", "person_inactive", "ticket_has_open_children", "ticket_cycle", "structure_busy", "concurrent_update", "server_busy",
  "project_archived", "comment_removed", "assistant_not_configured", "assistant_unavailable", "conversation_closed", "conversation_changed",
  "grouping_changed", "placement_stale", "draft_required", "ticket_has_no_items", "github_unavailable", "not_connected",
  "installation_unavailable", "repository_already_linked", "repository_not_found", "person_without_project_access", "assistant_consent_required", "contribution_area_taken", "area_in_use", "ticket_in_idea",
  "unknown_ticket_keys", "description_too_long", "request_too_long",
  "chat_busy", "chat_changed", "mention_not_allowed", "mention_mismatch", "person_mention_not_allowed", "participant_cannot_view_ticket", "assistant_mention_self", "too_many_mentions", "thread_full", "max_depth", "not_thread_owner", "principal_conversation", "ticket_mismatch", "not_principal", "chat_thread_rate_limited", "chat_rate_limited", "invalid_cursor",
  "test_people_total_limit", "display_name_taken", "invalid_display_name",
] as const);
type KnownCode = typeof KNOWN_CODES extends Set<infer C> ? C : never;

/**
 * A mensagem de um erro da API no idioma de `t` (função pura, para testes e uso fora de componente; em componente, use
 * `useDescribeApiError`). `remove` diz que a ação foi remover: o mesmo código `ticket_has_children` pede outra frase.
 * Código desconhecido cai na mensagem do tipo.
 */
export function describeApiError(translate: TFunction<any>, error: ApiError, action?: "remove"): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  // Chaves com o namespace por extenso: serve a qualquer `t`, de qualquer namespace. O teste percorre todas.
  const t = translate as unknown as (key: string, options?: Record<string, string>) => string;
  if (action === "remove" && error.code === "ticket_has_children") return t("api:errors.removeTicketWithItems");
  if (error.code === "unknown_ticket_keys") return t("api:errors.code.unknown_ticket_keys", { keys: (error.keys ?? []).join(", ") });
  if (error.code !== undefined && KNOWN_CODES.has(error.code as KnownCode)) return t(`api:errors.code.${error.code}`);
  return t(`api:errors.kind.${error.kind}`);
}

/** Para componentes: devolve `(error, action?) => texto`, que muda quando o idioma muda. */
export function useDescribeApiError(): (error: ApiError, action?: "remove") => string {
  const { t } = useTranslation("api");
  return useCallback((error: ApiError, action?: "remove") => describeApiError(t, error, action), [t]);
}
