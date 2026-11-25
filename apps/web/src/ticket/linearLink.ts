/**
 * O endereço do Linear que a página do ticket pode abrir (ADR 0060). A origem vem do servidor, mas o link sai da tela para um
 * site de fora: só vale `https://linear.app/…`, exatamente esse domínio, sem usuário, senha nem porta. Qualquer outra coisa (outro
 * esquema, subdomínio parecido, texto que não é endereço) não vira link.
 */
export function safeLinearUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.hostname !== "linear.app" || url.username !== "" || url.password !== "" || url.port !== "") return null;
  return url.href;
}
