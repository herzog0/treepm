import { createApiClient } from "./client.js";
import type { Me } from "./client.js";

export type MeResponse = Me;

export type MeResult =
  | { status: "ok"; data: MeResponse }
  | { status: "unauthenticated" }
  | { status: "forbidden" }
  | { status: "unavailable" };

export async function fetchMe(
  getToken: () => Promise<string | null>,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<MeResult> {
  const result = await createApiClient({ getToken, fetch: fetchImpl }).getMe();
  if (result.ok) return { status: "ok", data: result.data };
  const { kind } = result.error;
  return { status: kind === "unauthenticated" || kind === "forbidden" ? kind : "unavailable" };
}

export function getMeIndicatorText(result: MeResult | null): string | null {
  if (!result) return null;
  if (result.status === "ok") {
    return result.data.roles.clerk === "admin" ? "Administrador" : "Membro";
  }
  return result.status === "unavailable" ? "API indisponível" : "Sessão sem acesso à API";
}
