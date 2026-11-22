import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type * as EditorNamespace from "./RichDescriptionEditor.js";
import type { RichDescriptionProps } from "./RichDescriptionEditor.js";
import "./description.css";

export type { RichDescriptionProps } from "./RichDescriptionEditor.js";

type EditorModule = typeof EditorNamespace;

// O editor (Tiptap, marked e as extensões) é pesado e só serve a quem abre um ticket: fica fora do pedaço principal e é
// baixado na primeira vez que algo precisa mostrar ou editar uma descrição (ou antes, em segundo plano, com o mapa ocioso).
let loaded: EditorModule | null = null;
let loading: Promise<EditorModule> | null = null;

/** O ponto de importação do editor: os testes põem um espião aqui para contar, segurar ou derrubar o download. */
export const editorImport = { run: (): Promise<EditorModule> => import("./RichDescriptionEditor.js") };

/** Só para testes: esquece o editor já baixado, como numa página recém-aberta. */
export function forgetDescriptionEditor() {
  loaded = null;
  loading = null;
}

/** Baixa o editor (uma vez só). Uma falha não fica guardada: a próxima chamada tenta de novo. */
export function loadDescriptionEditor(): Promise<EditorModule> {
  loading ??= editorImport.run().then(
    (module) => (loaded = module),
    (error: unknown) => {
      loading = null;
      throw error;
    },
  );
  return loading;
}

const PRELOAD_DELAY_MS = 2500;

/**
 * Pede o download do editor quando o mapa já se desenhou e o navegador está ocioso, para o primeiro ticket abrir sem espera.
 * Falha em silêncio (o download de verdade, com "Tentar de novo", acontece quando alguém precisa do editor). Devolve o cancelamento.
 */
export function scheduleDescriptionEditorPreload(): () => void {
  if (loaded) return () => {};
  let idle: number | undefined;
  const start = () => void loadDescriptionEditor().catch(() => {});
  const timer = window.setTimeout(() => {
    if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(start, { timeout: 5000 });
    else start();
  }, PRELOAD_DELAY_MS);
  return () => {
    window.clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
  };
}

/** Enquanto o editor não chega (ou falha): o markdown cru em texto simples, com as quebras de linha, no mesmo lugar. */
function PlainDescription({ props, failed, onRetry }: { props: RichDescriptionProps; failed: boolean; onRetry: () => void }) {
  const { t } = useTranslation("ticket");
  const classes = ["description", "is-reading", "is-plain", props.className ?? ""].filter(Boolean).join(" ");
  return (
    <div className={classes}>
      <div className="description-plain" data-empty={props.value === "" ? "true" : undefined}>
        {props.value === "" ? props.placeholder : props.value}
      </div>
      {failed && (
        <p className="description-load-failed" role="alert">
          {t("description.loadFailed")}{" "}
          <button type="button" className="description-retry" onClick={onRetry}>
            {t("description.retry")}
          </button>
        </p>
      )}
    </div>
  );
}

/**
 * Descrição do ticket (ADR 0036). Carrega o editor sob demanda: até ele chegar mostra o texto simples, sem clique para editar
 * (o clique só vale quando o editor assume, para nada se perder); chegando, o editor assume o mesmo lugar.
 */
export function RichDescription(props: RichDescriptionProps) {
  const [module, setModule] = useState<EditorModule | null>(loaded);
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (module) return;
    let active = true;
    setFailed(false);
    loadDescriptionEditor().then(
      (next) => active && setModule(next),
      () => active && setFailed(true),
    );
    return () => {
      active = false;
    };
  }, [module, attempt]);

  const retry = useCallback(() => setAttempt((n) => n + 1), []);

  if (!module) return <PlainDescription props={props} failed={failed} onRetry={retry} />;
  const Editor = module.RichDescriptionEditor;
  return <Editor {...props} />;
}
