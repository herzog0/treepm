import { useCallback, useState } from "react";
import type { ApiError, ApiResult } from "../api/client.js";

/** Uma mutação por vez: `busy` enquanto envia e o último erro, para mostrar junto da ação. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);

  const run = useCallback(async <T,>(action: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
    setBusy(true);
    setError(null);
    let result: ApiResult<T>;
    try {
      result = await action();
    } catch {
      result = { ok: false, error: { kind: "unavailable" } };
    }
    setBusy(false);
    if (!result.ok) setError(result.error);
    return result;
  }, []);

  const clear = useCallback(() => setError(null), []);
  return { busy, error, run, clear };
}
