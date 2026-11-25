import { useEffect, useRef, useState } from "react";
import type { ApiResult } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useAction } from "../panel/useAction.js";

export interface AbandonText {
  button: string;
  confirmLabel: string;
  confirmBody: string;
  confirm: string;
  back: string;
}

/** "Abandonar": discreto durante a rodada, em destaque quando continuar não adianta; a confirmação é na própria tela. Serve à importação e à procura do lugar dos itens. */
export function AbandonControl({ prominent, onAbandon, text }: { prominent: boolean; onAbandon: () => Promise<ApiResult<unknown>>; text: AbandonText }) {
  const describeError = useDescribeApiError();
  const action = useAction();
  const [confirming, setConfirming] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const confirmButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
  }, [confirming]);
  const close = () => {
    setConfirming(false);
    // O botão que abriu a confirmação só volta ao DOM no próximo ciclo.
    setTimeout(() => opener.current?.focus(), 0);
  };
  const confirm = async () => {
    const result = await action.run(() => onAbandon());
    if (!result.ok) setConfirming(false);
  };
  return (
    <div className="linear-import-abandon">
      {!confirming && (
        <button ref={opener} type="button" className={`linear-import-abandon-button ${prominent ? "is-prominent" : "text"}`} onClick={() => setConfirming(true)}>{text.button}</button>
      )}
      {confirming && (
        <div role="group" aria-label={text.confirmLabel} className="linear-import-abandon-confirm" onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); close(); } }}>
          <p>{text.confirmBody}</p>
          <div className="linear-import-actions">
            <button ref={confirmButton} type="button" className="destructive" disabled={action.busy} onClick={() => void confirm()}>{text.confirm}</button>
            <button type="button" disabled={action.busy} onClick={close}>{text.back}</button>
          </div>
        </div>
      )}
      {action.error && <p role="alert" className="import-error-text">{describeError(action.error)}</p>}
    </div>
  );
}
