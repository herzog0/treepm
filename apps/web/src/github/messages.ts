import type { ApiError } from "../api/client.js";

export type CallbackErrorKey =
  | "expired"
  | "notYours"
  | "personalOnly"
  | "noInstallation"
  | "ambiguous"
  | "alreadyConnected"
  | "inUse"
  | "unavailable"
  | "forbidden"
  | "generic";

const BY_CODE: Record<string, CallbackErrorKey> = {
  invalid_state: "expired",
  invalid_code: "expired",
  installation_not_yours: "notYours",
  organization_account_unsupported: "personalOnly",
  no_installation: "noInstallation",
  installation_unavailable: "noInstallation",
  installation_ambiguous: "ambiguous",
  already_connected: "alreadyConnected",
  installation_in_use: "inUse",
  github_unavailable: "unavailable",
};

/** Chave da mensagem (`callback.error.*` do catálogo `github`) da tela de retorno do GitHub; nunca repete `code` nem `state`. */
export function callbackErrorKey(error: ApiError): CallbackErrorKey {
  const byCode = error.code === undefined ? undefined : BY_CODE[error.code];
  if (byCode) return byCode;
  if (error.kind === "forbidden") return "forbidden";
  return "generic";
}
