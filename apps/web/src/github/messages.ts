import type { ApiError } from "../api/client.js";

const BY_CODE: Record<string, string> = {
  invalid_state: "A conexão expirou. Comece de novo em Configurações.",
  invalid_code: "A conexão expirou. Comece de novo em Configurações.",
  installation_not_yours: "Esta instalação não é da sua conta do GitHub.",
  organization_account_unsupported: "Por enquanto o TreePM só aceita o app instalado em conta pessoal do GitHub.",
  no_installation: "O GitHub não encontrou a instalação do app. Instale de novo.",
  installation_unavailable: "O GitHub não encontrou a instalação do app. Instale de novo.",
  installation_ambiguous: "Há mais de uma instalação do app na sua conta. Comece de novo em Configurações.",
  already_connected: "Esta organização já está ligada ao GitHub.",
  installation_in_use: "Esta instalação do GitHub já está em uso.",
  github_unavailable: "O GitHub não respondeu. Tente de novo em instantes.",
};

/** Mensagem da tela de retorno do GitHub; nunca repete `code` nem `state`. */
export function describeCallbackError(error: ApiError): string {
  const byCode = error.code === undefined ? undefined : BY_CODE[error.code];
  if (byCode) return byCode;
  if (error.kind === "forbidden") return "Só um administrador da organização pode conectar o GitHub.";
  return "Não foi possível concluir a conexão com o GitHub.";
}
