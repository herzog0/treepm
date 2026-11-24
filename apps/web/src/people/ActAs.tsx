import { createContext, Fragment, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { onActAsRejected, readActAs, writeActAs } from "../api/actAs.js";
import type { ActingAs } from "../api/actAs.js";
import { resetIdeasSession } from "../ideas/session.js";
import "./people.css";

type ActAsApi = {
  /** Quem a aba está vendo como (pessoa de teste), ou `null` quando é a própria pessoa. */
  acting: ActingAs | null;
  enter: (person: ActingAs) => void;
  leave: () => void;
  /** O servidor, ou a conferência da identidade, disse que o modo não vale: sai dele e avisa. Só vale para a pessoa em que a aba está. */
  reject: (personId: string) => void;
};

const ActAsContext = createContext<ActAsApi>({ acting: null, enter: () => undefined, leave: () => undefined, reject: () => undefined });
export const useActAs = (): ActAsApi => useContext(ActAsContext);

/** A tela volta à raiz (mapa, sem ticket aberto): o que estava aberto era de outra pessoa e pode nem existir para esta. */
function resetLocation(): void {
  try {
    window.history.replaceState(window.history.state, "", window.location.pathname);
  } catch {
    /* sem histórico: a árvore remontada lê a mesma URL */
  }
}

/**
 * "Entrar como" uma pessoa de teste (ADR 0057). Guarda a escolha por aba; ao entrar, ao voltar ou quando o servidor recusa, a árvore
 * autenticada inteira é REMONTADA (`key`): nada da pessoa anterior (mapa, conversas, diretório, ticket aberto) sobra em memória.
 * Enquanto dura, uma faixa fixa no alto diz como quem se está vendo; ela divide a altura com a aplicação, não a cobre.
 */
export function ActAsProvider({ children }: { children: ReactNode }) {
  const { t } = useTranslation("app");
  const [acting, setActing] = useState<ActingAs | null>(() => readActAs());
  const [notice, setNotice] = useState<string | null>(null);

  // Quem a aba está vendo agora, para ignorar recusas de pedidos de uma árvore que já saiu de cena.
  const actingRef = useRef(acting);
  actingRef.current = acting;
  /** Troca de modo: o que a árvore anterior guardou fora dela (o último projeto de Ideias) não passa para a seguinte. */
  const switchTo = useCallback((next: ActingAs | null, rejectedName: string | null) => {
    writeActAs(next);
    resetLocation();
    resetIdeasSession();
    setNotice(rejectedName);
    setActing(next);
  }, []);
  const enter = useCallback((person: ActingAs) => switchTo(person, null), [switchTo]);
  const leave = useCallback(() => switchTo(null, null), [switchTo]);
  // O servidor recusou (pessoa desativada no meio, por exemplo): sai do modo sozinha e avisa.
  const reject = useCallback(
    (personId: string) => {
      const current = actingRef.current;
      if (current === null || current.id !== personId) return;
      switchTo(null, current.displayName);
    },
    [switchTo],
  );
  useEffect(() => onActAsRejected(reject), [reject]);

  const api = useMemo(() => ({ acting, enter, leave, reject }), [acting, enter, leave, reject]);
  const tree = <Fragment key={acting?.id ?? "self"}>{children}</Fragment>;
  return (
    <ActAsContext.Provider value={api}>
      {acting === null && notice === null ? (
        tree
      ) : (
        <div className="actas-frame">
          {acting !== null ? (
            <div className="actas-banner" role="status">
              <span>{t("actAs.banner", { name: acting.displayName })}</span>
              <button type="button" onClick={leave}>{t("actAs.leave")}</button>
            </div>
          ) : (
            <div className="actas-banner is-notice" role="alert">
              <span>{t("actAs.rejected", { name: notice })}</span>
              <button type="button" onClick={() => setNotice(null)}>{t("actAs.dismiss")}</button>
            </div>
          )}
          <div className="actas-body">{tree}</div>
        </div>
      )}
    </ActAsContext.Provider>
  );
}
