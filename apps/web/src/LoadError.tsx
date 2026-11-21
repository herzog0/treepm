import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { ApiError } from "./api/client.js";
import { describeApiError } from "./api/errorText.js";

/** `forbidden` e `unauthenticated` aqui são falta de acesso à API; o resto é indisponibilidade. */
export function loadErrorText(error: ApiError, t: TFunction): string {
  if (error.kind === "forbidden" || error.kind === "unauthenticated") return t("loadError.noAccess");
  if (error.kind === "unavailable") return t("loadError.unavailable");
  return describeApiError(t, error);
}

export function LoadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="load-error" role="alert">
      <p>{loadErrorText(error, t)}</p>
      <button type="button" onClick={onRetry}>
        {t("loadError.retry")}
      </button>
    </div>
  );
}
