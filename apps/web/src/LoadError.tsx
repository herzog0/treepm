import type { ApiError } from "./api/client.js";
import { describeApiError } from "./api/client.js";

/** `forbidden` e `unauthenticated` aqui são falta de acesso à API; o resto é indisponibilidade. */
export function loadErrorText(error: ApiError): string {
  if (error.kind === "forbidden" || error.kind === "unauthenticated") return "Sessão sem acesso à API.";
  if (error.kind === "unavailable") return "API indisponível.";
  return describeApiError(error);
}

export function LoadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  return (
    <div className="load-error" role="alert">
      <p>{loadErrorText(error)}</p>
      <button type="button" onClick={onRetry}>
        Tentar novamente
      </button>
    </div>
  );
}
