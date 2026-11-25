import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, ApiResult, CategorizeOverview, CategorizeView } from "../api/client.js";
import { safe } from "../panel/safe.js";
import { BACKOFF_CAP_MS, BACKOFF_START_MS, BUSY_CODES, BUSY_WAIT_MS, MAX_UNAVAILABLE_FAILURES } from "./useLinearRun.js";
import type { LoopState, RunLoad } from "./useLinearRun.js";

export interface UseLinearCategorizeOptions {
  /** Falso: a situação é lida, mas o laço não anda (a chave da pessoa não serve a este projeto). */
  enabled: boolean;
}

/**
 * Procurar o lugar dos itens importados (ADR 0060, seção 6), no molde de `useLinearRun`: lê a situação e, enquanto há rodada aberta,
 * chama o passo UM por vez até ela terminar. Um único laço assíncrono por montagem (e por "continuar"); ao desmontar ele é
 * cancelado, o temporizador pendente é limpo e a resposta de um passo no ar é ignorada. O servidor pode responder 200 sem avançar
 * (espera, ou erro do provedor com `errorStreak`): o laço espera e tenta de novo, cada vez mais devagar. Erro do portão da IA
 * (sem aceite, sem configuração) para o laço, que espera "Continuar" depois de a pessoa corrigir.
 */
export function useLinearCategorize(client: ApiClient, projectId: string, { enabled }: UseLinearCategorizeOptions) {
  const [load, setLoad] = useState<RunLoad>({ status: "loading" });
  const [overview, setOverview] = useState<CategorizeOverview | null>(null);
  const [run, setRunState] = useState<CategorizeView | null>(null);
  const [loop, setLoop] = useState<LoopState>({ kind: "idle" });
  /** Verdadeiro quando esta tela viu uma rodada aberta: o resumo ao terminar é de quem a viu andar. */
  const [watched, setWatched] = useState(false);
  const [version, setVersion] = useState(0);
  const [resumeToken, setResumeToken] = useState(0);
  const runRef = useRef<CategorizeView | null>(null);
  const alive = useRef(true);
  const setRun = useCallback((next: CategorizeView | null) => {
    runRef.current = next;
    setRunState(next);
    if (next !== null && !next.finished) setWatched(true);
  }, []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  /** Lê a situação. Em segundo plano (`quiet`) não volta a mostrar "carregando" nem pisca a tela. */
  const read = useCallback(
    async (quiet: boolean) => {
      const result = await safe(() => client.getLinearCategorize(projectId));
      if (!alive.current) return;
      if (result.ok) {
        setOverview(result.data);
        // Uma rodada que o laço está andando é mais nova que a lida: só a troca quando a lida tem a mesma id ou não há rodada em mãos.
        const current = runRef.current;
        if (current === null || current.finished || result.data.run?.id !== current.id || result.data.run.updatedAt >= current.updatedAt) setRun(result.data.run);
        setLoad({ status: "ready" });
      } else if (!quiet) setLoad({ status: "error", error: result.error });
    },
    [client, projectId, setRun],
  );

  useEffect(() => {
    setLoad({ status: "loading" });
    void read(false);
  }, [read, version]);

  const runId = run !== null && !run.finished ? run.id : null;
  useEffect(() => {
    if (runId === null || !enabled) {
      setLoop((current) => (current.kind === "idle" ? current : { kind: "idle" }));
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let wake: (() => void) | undefined;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
      });

    const drive = async () => {
      let failures = 0;
      while (active) {
        const current = runRef.current;
        if (current === null || current.finished) return;
        if (current.waitUntil !== null) {
          const remaining = Date.parse(current.waitUntil) - Date.now();
          if (remaining > 0) {
            setLoop({ kind: "waiting", until: current.waitUntil });
            await sleep(remaining);
            if (!active) return;
          }
        }
        setLoop((state) => (state.kind === "running" ? state : { kind: "running" }));
        const result: ApiResult<CategorizeView> = await safe(() => client.stepLinearCategorize(projectId, current.id));
        if (!active) return;
        if (result.ok) {
          failures = 0;
          setRun(result.data);
          if (result.data.finished) {
            setLoop({ kind: "idle" });
            void read(true);
            return;
          }
          if (result.data.errorStreak > 0 && result.data.lastErrorCode !== null) {
            // O provedor da IA errou: 200 sem avançar. Espera cada vez mais e tenta de novo.
            setLoop({ kind: "retrying", failures: result.data.errorStreak });
            await sleep(Math.min(BACKOFF_START_MS * 2 ** (result.data.errorStreak - 1), BACKOFF_CAP_MS));
          }
          continue;
        }
        const { error } = result;
        if (error.code !== undefined && BUSY_CODES.has(error.code)) {
          setLoop({ kind: "busy" });
          await sleep(BUSY_WAIT_MS);
          continue;
        }
        if (error.kind === "unavailable" && error.code === undefined) {
          failures += 1;
          if (failures >= MAX_UNAVAILABLE_FAILURES) {
            setLoop({ kind: "gave_up" });
            return;
          }
          setLoop({ kind: "retrying", failures });
          await sleep(Math.min(BACKOFF_START_MS * 2 ** (failures - 1), BACKOFF_CAP_MS));
          continue;
        }
        setLoop({ kind: "stopped", error });
        return;
      }
    };
    void drive();
    return () => {
      active = false;
      if (timer !== undefined) clearTimeout(timer);
      wake?.();
    };
  }, [client, projectId, runId, enabled, resumeToken, setRun, read]);

  /** Abre a rodada. Se outra aba já abriu uma (ou há importação andando), devolve o erro e relê a situação. */
  const open = useCallback(async (): Promise<ApiResult<CategorizeView>> => {
    const result = await safe(() => client.openLinearCategorize(projectId));
    if (result.ok) setRun(result.data);
    else if (result.error.code === "linear_categorize_open" || result.error.code === "linear_import_in_progress" || result.error.code === "linear_nothing_to_categorize") void read(true);
    return result;
  }, [client, projectId, setRun, read]);
  /** Abandona a rodada aberta: o que já foi decidido fica; uma rodada nova só procura o resto. */
  const abandon = useCallback(async (): Promise<ApiResult<CategorizeView>> => {
    const current = runRef.current;
    if (current === null) return { ok: false, error: { kind: "not_found" } };
    const result = await safe(() => client.abandonLinearCategorize(projectId, current.id));
    if (result.ok) {
      setRun(result.data);
      void read(true);
    }
    return result;
  }, [client, projectId, setRun, read]);
  /** "Tentar de novo" / "Continuar": recomeça o laço agora, sem esperar o recuo. */
  const resume = useCallback(() => setResumeToken((current) => current + 1), []);
  const reload = useCallback(() => setVersion((current) => current + 1), []);
  /** Relê a situação sem piscar (depois de uma importação ou de conferir um item). */
  const refresh = useCallback(() => void read(true), [read]);
  return { load, overview, run, watched, loop, open, abandon, resume, reload, refresh };
}
