import { useCallback, useEffect, useRef, useState } from "react";
import type { ApiClient, ApiError, ApiResult, LinearRun, OpenLinearRunBody } from "../api/client.js";
import { safe } from "../panel/safe.js";

/** Espera, em ms, antes de tentar de novo um passo que outra aba ou a fila de estrutura estava fazendo. */
const BUSY_WAIT_MS = 2_000;
/** O recuo do "o Linear não respondeu": 2 s, 4 s, 8 s, 16 s; na quinta falha seguida o laço para e pede "Tentar de novo". */
const BACKOFF_START_MS = 2_000;
const BACKOFF_CAP_MS = 30_000;
export const MAX_UNAVAILABLE_FAILURES = 5;
/** Códigos que dizem "outra execução está andando": não são erro, só espera curta. */
const BUSY_CODES = new Set(["linear_step_in_progress", "structure_busy"]);

/** O que o laço está fazendo; é o que a tela mostra, além da própria rodada. */
export type LoopState =
  | { kind: "idle" }
  | { kind: "running" }
  /** A outra aba ou a fila de estrutura estava no passo: espera 2 s e tenta de novo, sem alarme. */
  | { kind: "busy" }
  /** O Linear pediu para esperar até esta hora (ISO). */
  | { kind: "waiting"; until: string }
  /** O Linear não respondeu; tenta de novo sozinho, cada vez mais devagar. */
  | { kind: "retrying"; failures: number }
  /** Cinco falhas seguidas: o laço parou e espera "Tentar de novo". */
  | { kind: "gave_up" }
  /** Erro que a pessoa precisa resolver (chave, time, workspace): o laço parou e espera "Continuar". */
  | { kind: "stopped"; error: ApiError };

export type RunLoad = { status: "loading" } | { status: "ready" } | { status: "error"; error: ApiError };

export interface UseLinearRunOptions {
  /** Falso: a rodada é lida, mas o laço não anda (a chave da pessoa não serve a este projeto). */
  enabled: boolean;
}

/**
 * A rodada de importação do Linear de um projeto e o laço que a faz andar (ADR 0060, seção 3): lê `runs/current`, e enquanto há
 * rodada aberta chama o passo, UM por vez, até concluir. Tudo vive num único laço assíncrono por montagem (e por "continuar"):
 * ao desmontar ele é cancelado, o temporizador pendente é limpo e a resposta de um passo no ar é ignorada. Nada de laço vivo
 * depois de a tela sair.
 */
export function useLinearRun(client: ApiClient, projectId: string, { enabled }: UseLinearRunOptions) {
  const [load, setLoad] = useState<RunLoad>({ status: "loading" });
  const [run, setRunState] = useState<LinearRun | null>(null);
  const [loop, setLoop] = useState<LoopState>({ kind: "idle" });
  const [version, setVersion] = useState(0);
  const [resumeToken, setResumeToken] = useState(0);
  const runRef = useRef<LinearRun | null>(null);
  const setRun = useCallback((next: LinearRun | null) => {
    runRef.current = next;
    setRunState(next);
  }, []);

  useEffect(() => {
    let active = true;
    void safe(() => client.getCurrentLinearRun(projectId)).then((result) => {
      if (!active) return;
      if (result.ok) {
        setRun(result.data.run);
        setLoad({ status: "ready" });
      } else setLoad({ status: "error", error: result.error });
    });
    return () => {
      active = false;
    };
  }, [client, projectId, version, setRun]);

  const runId = run !== null && !run.done ? run.id : null;
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
        if (current === null || current.done) return;
        if (current.waitUntil !== null) {
          const remaining = Date.parse(current.waitUntil) - Date.now();
          if (remaining > 0) {
            setLoop({ kind: "waiting", until: current.waitUntil });
            await sleep(remaining);
            if (!active) return;
          }
        }
        setLoop((state) => (state.kind === "running" ? state : { kind: "running" }));
        const result: ApiResult<LinearRun> = await safe(() => client.stepLinearRun(projectId, current.id));
        if (!active) return;
        if (result.ok) {
          failures = 0;
          setRun(result.data);
          if (result.data.done) {
            setLoop({ kind: "idle" });
            return;
          }
          continue;
        }
        const { error } = result;
        if (error.code !== undefined && BUSY_CODES.has(error.code)) {
          setLoop({ kind: "busy" });
          await sleep(BUSY_WAIT_MS);
          continue;
        }
        if (error.code === "linear_rate_limited") {
          // O limite como erro (429): a espera vale o prazo dito, sem gravar nada na rodada.
          const seconds = error.details?.["retryAfterSeconds"];
          const wait = typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0 ? Math.min(Math.ceil(seconds), 3600) : 60;
          const until = new Date(Date.now() + wait * 1000).toISOString();
          setRun({ ...current, waitUntil: until });
          continue;
        }
        if (error.kind === "unavailable" && (error.code === undefined || error.code === "linear_unavailable")) {
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
  }, [client, projectId, runId, enabled, resumeToken, setRun]);

  /** Abre a rodada. Se outra aba já abriu uma, devolve o erro e relê a atual (a tela passa a mostrá-la andando). */
  const open = useCallback(
    async (body: OpenLinearRunBody): Promise<ApiResult<LinearRun>> => {
      const result = await safe(() => client.openLinearRun(projectId, body));
      if (result.ok) setRun(result.data);
      else if (result.error.code === "linear_run_open") setVersion((current) => current + 1);
      return result;
    },
    [client, projectId, setRun],
  );
  /**
   * Abandona a rodada aberta: o que já foi importado fica. Dando certo, a rodada passa a `failed` (e o laço, que só anda em
   * rodada aberta, para); se ela já tinha terminado (`linear_run_finished`), relê a atual.
   */
  const abandon = useCallback(async (): Promise<ApiResult<LinearRun>> => {
    const current = runRef.current;
    if (current === null) return { ok: false, error: { kind: "not_found" } };
    const result = await safe(() => client.abandonLinearRun(projectId, current.id));
    if (result.ok) setRun(result.data);
    else if (result.error.code === "linear_run_finished") setVersion((value) => value + 1);
    return result;
  }, [client, projectId, setRun]);
  /** "Tentar de novo" / "Continuar": recomeça o laço agora, sem esperar o recuo. */
  const resume = useCallback(() => setResumeToken((current) => current + 1), []);
  const reload = useCallback(() => {
    setLoad({ status: "loading" });
    setVersion((current) => current + 1);
  }, []);
  return { load, run, loop, open, abandon, resume, reload };
}
