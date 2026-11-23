import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { TicketSummary } from "../api/client.js";

type AgentWork = TicketSummary["agentWork"];

/** O marcador de trabalho pela IA vale enquanto `until` é futuro (ADR 0043); a web confere contra o relógio dela. */
export const isAgentWorkActive = (agentWork: AgentWork, now: number): boolean => {
  if (!agentWork) return false;
  const until = Date.parse(agentWork.until);
  return Number.isFinite(until) && until > now;
};

/** O maior atraso que `setTimeout` aceita; um prazo mais longo espera em etapas. */
const MAX_DELAY = 2 ** 31 - 1;

/**
 * O marcador vale agora? Muda sozinho para falso quando `until` passa, por um único temporizador (sem nova busca e
 * sem relógio a cada quadro).
 */
export function useAgentWorkActive(agentWork: AgentWork): boolean {
  const [now, setNow] = useState(() => Date.now());
  const until = agentWork ? Date.parse(agentWork.until) : Number.NaN;
  useEffect(() => {
    const current = Date.now();
    setNow(current);
    if (!(until > current)) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(until - current, MAX_DELAY));
    return () => clearTimeout(timer);
  }, [until]);
  return isAgentWorkActive(agentWork, now);
}

/**
 * A marca do contorno animado (ADR 0043): um elemento sem tamanho dentro do card, para o leitor de tela e para o CSS
 * (`agent-work.css`) saber que o card está em trabalho, em todos os níveis (inclusive o ponto, em que o conteúdo é
 * escondido mas continua no DOM). O contorno em si é um `<svg>` com um retângulo de cantos arredondados, que entra como
 * filho do `.spatial-card-visual` (por portal): o botão do card corta o que passa dele, e o contorno fica fora do card.
 */
export function AgentWorkMark({ agentWork }: { agentWork: AgentWork }) {
  const { t } = useTranslation("map");
  const active = useAgentWorkActive(agentWork);
  const [surface, setSurface] = useState<Element | null>(null);
  const markRef = useCallback((mark: HTMLElement | null) => setSurface(mark?.closest(".spatial-card-visual") ?? null), []);
  if (!active) return null;
  return (
    <>
      <span ref={markRef} className="node-agent-work">{t("agentWork.label")}</span>
      {surface && createPortal(<svg className="agent-work-ring" aria-hidden="true" focusable="false"><rect /></svg>, surface)}
    </>
  );
}

/**
 * O "agora" do mapa para o que não tem componente próprio (o rótulo de leitor de tela dos nós): muda uma vez em cada
 * instante em que um marcador vence, por um único temporizador, e nunca se nada vencer.
 */
export function useAgentWorkClock(untils: readonly (string | undefined)[]): number {
  const [now, setNow] = useState(() => Date.now());
  // O mapa renderiza a cada quadro da câmera com a mesma lista: reler os prazos de todos os tickets (um `Date.parse` cada) só quando ela ou o relógio mudam.
  const next = useMemo(() => untils.reduce<number>((soonest, value) => {
    const until = value === undefined ? Number.NaN : Date.parse(value);
    return until > now && until < soonest ? until : soonest;
  }, Number.POSITIVE_INFINITY), [untils, now]);
  useEffect(() => {
    if (next === Number.POSITIVE_INFINITY) return;
    const timer = setTimeout(() => setNow(Date.now()), Math.min(Math.max(next - Date.now(), 0), MAX_DELAY));
    return () => clearTimeout(timer);
  }, [next]);
  return now;
}
