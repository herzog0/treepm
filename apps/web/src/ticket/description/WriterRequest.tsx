import { useEffect, useId, useRef, useState } from "react";
import { ConsentRequiredNotice } from "../../api/ConsentRequired.js";
import type { CSSProperties, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import { RichDescription } from "./RichDescription.js";

/** Resultado do pedido ao assistente, como o editor o vê: o texto em markdown, ou falha (sem dizer por quê). */
/** `consentRequired`: a organização não tem (mais) o aceite da IA em vigor (ADR 0039); repetir não adianta. */
export type DraftResult = { ok: true; text: string } | { ok: false; consentRequired?: boolean };
/** Pede o trecho. `description` é o texto atual do editor; o `signal` cancela o pedido. */
export type DraftRequest = (request: string, description: string, signal: AbortSignal) => Promise<DraftResult>;

type Phase = { kind: "input" } | { kind: "busy" } | { kind: "proposal"; text: string } | { kind: "error"; consentRequired?: boolean };

const WIDTH = 460;
const HEIGHT = 340;

/** A posição do campo e da proposta: junto do cursor, como os menus, virando para cima quando falta lugar embaixo. */
function placement(rect: { left: number; top: number; bottom: number } | null): CSSProperties {
  if (!rect) return { left: 8, top: 8, width: WIDTH };
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - WIDTH - 8));
  return rect.bottom + HEIGHT > window.innerHeight && rect.top > HEIGHT ? { left, bottom: window.innerHeight - rect.top + 6, width: WIDTH } : { left, top: rect.bottom + 6, width: WIDTH };
}

interface WriterRequestProps {
  /** Onde o campo se ancora (o cursor), em coordenadas da janela; muda com a rolagem. */
  anchor: () => { left: number; top: number; bottom: number } | null;
  /** O texto atual do editor, no momento do envio. */
  currentText: () => string;
  onDraft: DraftRequest;
  /** "Inserir": a proposta vira blocos no lugar do cursor. */
  onInsert: (text: string) => void;
  /** Fecha sem mudar o texto (Esc, "Descartar"). */
  onClose: () => void;
}

/**
 * O campo "O que o assistente deve escrever?" e a proposta (ADR 0036, fatia 5). Faz parte da edição da descrição: nada aqui
 * grava nada; o texto só entra no editor por "Inserir", e a descrição só é salva pelo caminho de sempre.
 */
export function WriterRequest({ anchor, currentText, onDraft, onInsert, onClose }: WriterRequestProps) {
  const { t } = useTranslation("ticket");
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const insert = useRef<HTMLButtonElement>(null);
  const retry = useRef<HTMLButtonElement>(null);
  const controller = useRef<AbortController | null>(null);
  const [request, setRequest] = useState("");
  const [phase, setPhase] = useState<Phase>({ kind: "input" });
  const [, redraw] = useState(0);

  useEffect(() => input.current?.focus(), []);
  // O campo acompanha a rolagem e o redimensionamento, como o cursor.
  useEffect(() => {
    const move = () => redraw((count) => count + 1);
    window.addEventListener("scroll", move, true);
    window.addEventListener("resize", move);
    return () => {
      window.removeEventListener("scroll", move, true);
      window.removeEventListener("resize", move);
    };
  }, []);
  // Fechar com a requisição em andamento a cancela.
  useEffect(() => () => controller.current?.abort(), []);
  // Quando a proposta (ou o erro) chega, o foco vai para o botão que a pessoa usa em seguida.
  useEffect(() => {
    if (phase.kind === "proposal") insert.current?.focus();
    else if (phase.kind === "error") retry.current?.focus();
  }, [phase.kind]);

  const send = async () => {
    const text = request.trim();
    if (text === "" || phase.kind === "busy") return;
    const current = new AbortController();
    controller.current = current;
    setPhase({ kind: "busy" });
    const result = await onDraft(text, currentText(), current.signal).catch((): DraftResult => ({ ok: false }));
    if (current.signal.aborted) return;
    controller.current = null;
    setPhase(result.ok ? { kind: "proposal", text: result.text } : { kind: "error", ...(result.consentRequired ? { consentRequired: true } : {}) });
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      // Só o campo: nem a edição nem a página nem o mapa veem esta tecla.
      event.stopPropagation();
      event.preventDefault();
      if (phase.kind === "busy") {
        // Cancela o pedido e volta ao campo, com o texto do pedido preservado.
        controller.current?.abort();
        controller.current = null;
        setPhase({ kind: "input" });
        requestAnimationFrame(() => input.current?.focus());
      } else {
        onClose();
      }
      return;
    }
    if (event.key === "Enter" && event.target === input.current && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      event.preventDefault();
      event.stopPropagation();
      void send();
    }
  };

  const busy = phase.kind === "busy";
  return (
    <div className="description-writer" role="group" aria-label={t("writer.label")} style={placement(anchor())} onKeyDown={onKeyDown}>
      <input
        ref={input}
        className="description-writer-input"
        type="text"
        value={request}
        readOnly={busy}
        aria-busy={busy}
        aria-label={t("writer.prompt")}
        aria-describedby={`${id}-hint`}
        placeholder={t("writer.prompt")}
        autoComplete="off"
        onChange={(event) => setRequest(event.target.value)}
      />
      <div id={`${id}-hint`} className="description-writer-hint" aria-hidden="true">{busy ? t("writer.writingHint") : t("writer.hint")}</div>
      <div className="description-writer-status" role="status" aria-live="polite" aria-atomic="true">{busy ? t("writer.writing") : ""}</div>
      {phase.kind === "error" && (
        <div className="description-writer-error">
          {phase.consentRequired ? <ConsentRequiredNotice /> : <p role="alert">{t("writer.error")}</p>}
          <button ref={retry} type="button" onClick={() => void send()}>{t("writer.retry")}</button>
        </div>
      )}
      {phase.kind === "proposal" && (
        <section className="description-writer-proposal" role="region" aria-label={t("writer.proposal")}>
          <div className="description-writer-text">
            <RichDescription value={phase.text} editing={false} canEdit={false} label={t("writer.proposal")} placeholder="" />
          </div>
          <div className="description-writer-actions">
            <button ref={insert} type="button" className="primary" onClick={() => onInsert(phase.text)}>{t("writer.insert")}</button>
            <button type="button" onClick={onClose}>{t("writer.discard")}</button>
          </div>
        </section>
      )}
    </div>
  );
}
