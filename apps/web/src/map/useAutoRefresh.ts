import { useEffect, useRef } from "react";

/** De quanto em quanto tempo o mapa busca os tickets de novo, com a aba visível (ADR 0043). */
export const REFRESH_INTERVAL_MS = 30_000;

/**
 * Chama `refresh` a cada `intervalMs` e ao voltar para a aba, só com a aba visível. Nunca começa uma chamada com outra
 * em andamento; uma falha não chega a ninguém (a próxima volta tenta de novo); ao desmontar, tudo para e uma chamada
 * ainda em andamento termina sem efeito, porque quem chama confere `isActive`.
 */
export function useAutoRefresh(refresh: (isActive: () => boolean) => Promise<void>, intervalMs: number = REFRESH_INTERVAL_MS): void {
  const latest = useRef(refresh);
  latest.current = refresh;
  useEffect(() => {
    let alive = true;
    let running = false;
    let timer: ReturnType<typeof setInterval> | null = null;
    const visible = () => document.visibilityState === "visible";
    const run = async () => {
      if (!alive || running || !visible()) return;
      running = true;
      try {
        await latest.current(() => alive);
      } catch {
        // Falha de rede é silenciosa.
      } finally {
        running = false;
      }
    };
    const stop = () => {
      if (timer !== null) clearInterval(timer);
      timer = null;
    };
    const start = () => {
      stop();
      timer = setInterval(() => void run(), intervalMs);
    };
    const onVisibility = () => {
      if (visible()) {
        void run();
        start();
      } else stop();
    };
    if (visible()) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [intervalMs]);
}
