import type { ApiResult } from "../api/client.js";

/** Um cliente que lança (rede, bug) vira "indisponível" em vez de rejeição não tratada. */
export async function safe<T>(load: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await load();
  } catch {
    return { ok: false, error: { kind: "unavailable" } };
  }
}
