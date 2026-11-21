import { useEffect, useRef, useState } from "react";
import type { ApiClient, CompleteGithubBody } from "../api/client.js";
import { describeCallbackError } from "./messages.js";
import "./github.css";

export const GITHUB_CALLBACK_PATH = "/github/callback";

type Arrival =
  | { kind: "complete"; body: CompleteGithubBody }
  | { kind: "notice"; text: string };

type Phase = { status: "working" } | { status: "done"; accountLogin: string } | { status: "notice" | "error"; text: string };

/** Lê a consulta do retorno uma vez. O GitHub manda `code`, `state` e, na prática, `installation_id` e `setup_action`. */
function readArrival(search: string): Arrival {
  const params = new URLSearchParams(search);
  if (params.get("setup_action") === "request") {
    return { kind: "notice", text: "O pedido de instalação foi enviado e precisa ser aprovado no GitHub." };
  }
  const code = params.get("code");
  const state = params.get("state");
  if (!code || !state) return { kind: "notice", text: "A instalação não foi concluída no GitHub." };
  const rawId = params.get("installation_id");
  const installationId = rawId !== null && /^[0-9]+$/.test(rawId) ? Number(rawId) : 0;
  return { kind: "complete", body: { code, state, ...(Number.isSafeInteger(installationId) && installationId > 0 ? { installationId } : {}) } };
}

/**
 * Tela de retorno do GitHub (`/github/callback`, ADR 0032): conclui a conexão uma única vez e leva a pessoa de volta
 * às Configurações. `code` e `state` saem da barra de endereço antes da chamada e nunca vão para a tela.
 */
export function GithubCallback({ client, onOpenSettings }: { client: ApiClient; onOpenSettings: () => void }) {
  const [arrival] = useState(() => readArrival(window.location.search));
  const [phase, setPhase] = useState<Phase>(() => (arrival.kind === "complete" ? { status: "working" } : { status: "notice", text: arrival.text }));
  // O efeito roda duas vezes em desenvolvimento (StrictMode), e o código só vale uma vez.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    window.history.replaceState(window.history.state, "", GITHUB_CALLBACK_PATH);
    if (arrival.kind !== "complete") return;
    const finish = (result: Awaited<ReturnType<ApiClient["completeGithubConnection"]>>) =>
      setPhase(result.ok ? { status: "done", accountLogin: result.data.installation.accountLogin } : { status: "error", text: describeCallbackError(result.error) });
    client.completeGithubConnection(arrival.body).then(finish, () => finish({ ok: false, error: { kind: "unavailable" } }));
  }, [arrival, client]);

  const leave = () => {
    window.history.replaceState(window.history.state, "", "/");
    onOpenSettings();
  };

  return (
    <div className="github-callback">
      <h1>GitHub</h1>
      {phase.status === "working" && <p role="status">Conferindo a conexão com o GitHub…</p>}
      {phase.status === "done" && <p role="status">{`GitHub conectado à conta ${phase.accountLogin}.`}</p>}
      {phase.status === "notice" && <p>{phase.text}</p>}
      {phase.status === "error" && <p role="alert">{phase.text}</p>}
      {phase.status === "done" && (
        <button type="button" className="primary" onClick={leave}>
          Continuar
        </button>
      )}
      {(phase.status === "notice" || phase.status === "error") && (
        <button type="button" onClick={leave}>
          Voltar
        </button>
      )}
    </div>
  );
}
