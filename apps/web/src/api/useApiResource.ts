import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiError, ApiResult } from "./client.js";

export type ResourceState<T> =
  | { status: "loading" }
  | { status: "ready"; data: T }
  | { status: "error"; error: ApiError };

/** Carrega um recurso ao montar e a cada `reload`; descarta respostas de cargas antigas. */
export function useApiResource<T>(load: () => Promise<ApiResult<T>>) {
  const [state, setState] = useState<ResourceState<T>>({ status: "loading" });
  const [version, setVersion] = useState(0);
  const currentVersion = useRef(version);
  currentVersion.current = version;

  useEffect(() => {
    let active = true;
    // Recargas mantêm os dados anteriores na tela; só a primeira carga mostra "carregando".
    void load().then((result) => {
      if (!active) return;
      setState(result.ok ? { status: "ready", data: result.data } : { status: "error", error: result.error });
    });
    return () => {
      active = false;
    };
  }, [version]);

  /**
   * Troca os dados prontos por `merge(atual)`; devolver o próprio objeto atual não muda nada (nada se redesenha). Uma
   * busca em segundo plano começada antes de uma recarga (`startedAt`) não pode sobrescrever o que a recarga trouxe.
   */
  const update = useCallback((merge: (current: T) => T, startedAt?: number) => {
    if (startedAt !== undefined && startedAt !== currentVersion.current) return;
    setState((state) => {
      if (state.status !== "ready") return state;
      const data = merge(state.data);
      return data === state.data ? state : { status: "ready", data };
    });
  }, []);
  const reload = useCallback(() => setVersion((current) => current + 1), []);
  const retry = useCallback(() => {
    setState({ status: "loading" });
    setVersion((current) => current + 1);
  }, []);
  return { state, reload, retry, update, version };
}
