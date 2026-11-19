import { useCallback, useRef, useState } from "react";
import type { ApiResult } from "../api/client.js";
import { describeApiError } from "../api/client.js";

/** Executa uma mutação: `pending` durante o envio, `error` com a mensagem em português se falhar. */
export function useMutation() {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);
  // Em StrictMode o efeito de montagem roda duas vezes; o ref acompanha o último estado real.
  mounted.current = true;

  const run = useCallback(async <T,>(action: () => Promise<ApiResult<T>>): Promise<boolean> => {
    setPending(true);
    setError(null);
    const result = await action();
    if (!mounted.current) return result.ok;
    setPending(false);
    if (!result.ok) setError(describeApiError(result.error));
    return result.ok;
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return { pending, error, run, clearError };
}
