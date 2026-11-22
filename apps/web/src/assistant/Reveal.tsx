import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

/** Um passo da revelação, em milissegundos (TREEPM-194): entre 20 e 40 ms. */
export const REVEAL_STEP_MS = 30;
/** Teto da revelação inteira: respostas longas mostram várias palavras por passo para caber nele. */
export const REVEAL_MAX_MS = 1500;

/** Onde termina cada palavra do texto (com os espaços que a seguem), para o prefixo nunca cortar uma palavra ao meio. */
function wordEnds(text: string): number[] {
  return Array.from(text.matchAll(/\S+\s*/g), (match) => match.index + match[0].length);
}

function prefersReducedMotion(): boolean {
  return typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface RevealProps {
  text: string;
  /** Revela aos poucos; falso mostra o texto inteiro (histórico retomado, resposta já revelada). */
  active: boolean;
  /** A revelação acabou (por tempo, por tecla ou clique, ou por movimento reduzido). */
  onDone: () => void;
  /** Chamada a cada trecho novo revelado (a folha acompanha o fim do texto com a rolagem). */
  onStep?: () => void;
  /** Recebe o trecho já revelado e se a revelação está em curso (o texto parcial não deve ser lido por leitor de tela). */
  children: (shown: string, revealing: boolean) => ReactNode;
}

/**
 * Faz o texto de uma resposta que já chegou inteira "parecer que vem": aparece por palavras, em passos de `REVEAL_STEP_MS`,
 * em no máximo `REVEAL_MAX_MS`. Com `prefers-reduced-motion`, aparece inteira de uma vez. Clique ou tecla mostram o resto na hora.
 * A API ainda responde de uma vez (o fluxo de verdade pelo servidor é outro ticket); isto é só a apresentação.
 */
export function Reveal({ text, active, onDone, onStep, children }: RevealProps) {
  const ends = useRef<number[]>([]);
  const [steps, setSteps] = useState(0);
  const [skipped, setSkipped] = useState(false);
  const doneRef = useRef(onDone);
  doneRef.current = onDone;
  const reduce = active && prefersReducedMotion();
  ends.current = wordEnds(text);
  const total = Math.min(ends.current.length, Math.floor(REVEAL_MAX_MS / REVEAL_STEP_MS));
  const perStep = total === 0 ? 1 : Math.ceil(ends.current.length / total);
  const finished = !active || reduce || skipped || steps >= total;

  useEffect(() => {
    if (!active || !finished) return;
    doneRef.current();
  }, [active, finished]);

  useEffect(() => {
    if (!active || finished) return;
    const timer = window.setInterval(() => setSteps((current) => current + 1), REVEAL_STEP_MS);
    const skip = () => setSkipped(true);
    window.addEventListener("pointerdown", skip, true);
    window.addEventListener("keydown", skip, true);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("pointerdown", skip, true);
      window.removeEventListener("keydown", skip, true);
    };
  }, [active, finished]);

  const shown = finished ? text : text.slice(0, ends.current[Math.min(steps * perStep, ends.current.length) - 1] ?? 0);
  const stepRef = useRef(onStep);
  stepRef.current = onStep;
  useLayoutEffect(() => {
    if (active) stepRef.current?.();
  }, [active, shown]);
  return <>{children(shown, !finished)}</>;
}
