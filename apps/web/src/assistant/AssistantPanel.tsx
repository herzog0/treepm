import { useEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import type { ApiClient, ApiError, ApiResult, ConversationDetail, PlacementOutcome, Project, TicketSummary } from "../api/client.js";
import { describeApiError } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import type { MapDraft, MapNode } from "../map/items.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { PathCard } from "./PathCard.js";
import { destinationUnder, oneLevelUp } from "./placement.js";
import type { Destination } from "./placement.js";
import type { MapPicker } from "./types.js";
import "./assistant.css";

/** Limite da API para uma mensagem da pessoa (`MAX_PERSON_MESSAGE`). */
export const MAX_MESSAGE = 4000;
const WARN_AT = 3600;

export interface AssistantPanelProps {
  client: ApiClient;
  /** Projetos em que a pessoa pode criar ticket (não arquivados). */
  projects: readonly Project[];
  /** Projeto do ticket ou projeto selecionado; `null` pede a escolha antes da primeira mensagem. */
  initialProjectId: string | null;
  /** Tickets de cada projeto, como o mapa os tem: o painel deriva daqui os caminhos que ele mesmo monta. */
  tickets: Readonly<Record<string, readonly TicketSummary[]>>;
  /** Fecha sem criar. */
  onClose: () => void;
  /** Depois de criar: o mapa recarrega (`onChanged`) e abre a página do ticket novo. */
  onCreated: (ticketId: string) => void;
  /** Caminho de saída quando a IA falha: o modo de criação manual da página do ticket. */
  onManualCreate: (request: { projectId: string; parentId: string | null; draft?: { title: string; description: string } }) => void;
  /** Onde o mapa mostra o card tracejado; `null` quando não há destino. */
  onDraftChange: (draft: MapDraft | null) => void;
  onChanged: () => void;
  /** Enquanto a pessoa "escolhe no mapa", o mapa envia os cliques em nós a este objeto. */
  registerPicker: (picker: MapPicker | null) => void;
}

const CloseIcon = () => (
  <svg aria-hidden="true" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
    <path d="m3 3 8 8M11 3l-8 8" />
  </svg>
);
const SendIcon = () => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </svg>
);

/** Painel de conversa para criar ticket com a IA (ADR 0029): região complementar de 440 px à direita do mapa. */
export function AssistantPanel(props: AssistantPanelProps) {
  const { projects, initialProjectId, onClose } = props;
  const ref = useRef<HTMLElement>(null);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [choosing, setChoosing] = useState(false);
  const project = projects.find((entry) => entry.id === projectId) ?? null;

  // O foco entra no painel ao abrir e volta a quem o abriu ao fechar (o campo de texto toma o foco quando carrega).
  useEffect(() => {
    const opener = document.activeElement;
    ref.current?.focus();
    return () => {
      if (opener instanceof HTMLElement && opener.isConnected) opener.focus();
    };
  }, []);

  const onKeyDown = (event: KeyboardEvent) => {
    // Nada do que acontece aqui dentro chega aos atalhos do mapa.
    event.stopPropagation();
    if (event.key !== "Escape") return;
    if (choosing) setChoosing(false);
    else onClose();
  };

  return (
    <aside ref={ref} className="assistant-panel" aria-label="Novo ticket com o assistente" tabIndex={-1} onKeyDown={onKeyDown}>
      <header className="assistant-header">
        <div>
          <h2>Novo ticket</h2>
          <p>{project ? `${project.key} · ${project.name}` : "O assistente conhece a árvore e lembra das conversas anteriores"}</p>
        </div>
        <button type="button" className="assistant-close" aria-label="Fechar conversa" onClick={onClose}>
          <CloseIcon />
        </button>
      </header>
      {project === null ? (
        <div className="assistant-scroll">
          <h3>Em qual projeto?</h3>
          <ul className="assistant-projects">
            {projects.map((entry) => (
              <li key={entry.id}>
                <button type="button" onClick={() => setProjectId(entry.id)}>{entry.key} · {entry.name}</button>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <ProjectConversation key={project.id} {...props} project={project} choosing={choosing} setChoosing={setChoosing} />
      )}
    </aside>
  );
}

interface ConversationProps extends AssistantPanelProps {
  project: Project;
  choosing: boolean;
  setChoosing: (choosing: boolean) => void;
}

/** A conversa aberta mais recente da pessoa no projeto continua de onde parou. */
function ProjectConversation(props: ConversationProps) {
  const { client, project } = props;
  const loaded = useApiResource(() =>
    safe(async (): Promise<ApiResult<ConversationDetail | null>> => {
      const list = await client.listConversations(project.id);
      if (!list.ok) return list;
      const latest = list.data.filter((entry) => entry.status === "open").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      return latest ? client.getConversation(latest.id) : { ok: true, data: null };
    }),
  );

  if (loaded.state.status === "loading") {
    return <div className="assistant-scroll"><p role="status" className="assistant-hint">Carregando a conversa…</p></div>;
  }
  if (loaded.state.status === "error") {
    return <div className="assistant-scroll"><LoadError error={loaded.state.error} onRetry={loaded.retry} /></div>;
  }
  return <Chat {...props} initial={loaded.state.data} />;
}

interface Edit {
  title: string;
  description: string;
}

function Chat(props: ConversationProps & { initial: ConversationDetail | null }) {
  const { client, project, tickets, choosing, setChoosing, onChanged, onCreated, onManualCreate } = props;
  const registerPicker = props.registerPicker;
  const list = tickets[project.id] ?? [];
  const [conversation, setConversation] = useState(props.initial);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ApiError | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [outcome, setOutcome] = useState<PlacementOutcome | null>(null);
  const [target, setTarget] = useState<Destination | null>(null);
  const [pickNotice, setPickNotice] = useState("");
  // Frase que explica por que o destino escolhido no mapa não é o nó em que a pessoa clicou (ADR 0031).
  const [pickedNote, setPickedNote] = useState("");
  const sendingRef = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const save = useAction();
  const search = useAction();
  const create = useAction();
  const removal = useAction();

  const draft = conversation?.draft ?? null;
  const fields: Edit | null = draft ? edit ?? { title: draft.title, description: draft.description } : null;
  const dirty = draft !== null && fields !== null && (fields.title !== draft.title || fields.description !== draft.description);
  const busy = save.busy || search.busy || create.busy || removal.busy;

  // O card tracejado do mapa segue o destino e o título salvo do rascunho.
  const onDraftChange = useRef(props.onDraftChange);
  onDraftChange.current = props.onDraftChange;
  const ghostTitle = draft?.title ?? null;
  const ghostParent = target === null ? undefined : target.parentId;
  useEffect(() => {
    onDraftChange.current(ghostParent === undefined || ghostTitle === null ? null : { projectId: project.id, parentId: ghostParent, title: ghostTitle });
  }, [ghostParent, ghostTitle, project.id]);
  useEffect(() => () => onDraftChange.current(null), []);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [conversation?.messages.length, outcome, sendError]);

  // "Escolher no mapa": o próximo clique em agrupador ou projeto do mesmo projeto vira o destino. Um ticket não tem
  // itens (ADR 0031): clicar nele escolhe o agrupador que o contém, ou a raiz do projeto, e o painel diz isso.
  const register = useRef(registerPicker);
  register.current = registerPicker;
  const pick = useRef<(node: MapNode) => void>(() => undefined);
  pick.current = (node) => {
    const clicked = node.kind === "ticket" && node.ticket?.projectId === project.id ? node.ticket : null;
    const parentId = node.kind === "project" && node.id === project.id ? null : clicked ? (clicked.kind === "group" ? clicked.id : clicked.parentId) : undefined;
    if (parentId === undefined) {
      setPickNotice(`Esta conversa é do projeto ${project.name}. Clique em um agrupador ou no próprio projeto.`);
      return;
    }
    const destination = destinationUnder(list, parentId);
    setTarget(destination);
    setPickedNote(clicked && clicked.kind === "ticket" ? `«${clicked.title}» é um ticket. O destino passou a ser ${destination.path.length === 0 ? "a raiz do projeto" : `«${destination.path.at(-1)!.title}»`}.` : "");
    setPickNotice("");
    setChoosing(false);
  };
  useEffect(() => {
    if (!choosing) return;
    setPickNotice("");
    register.current({ pick: (node) => pick.current(node), cancel: () => setChoosing(false) });
    return () => register.current(null);
  }, [choosing, setChoosing]);

  const clearPlacement = () => {
    setPickedNote("");
    setOutcome(null);
    setTarget(null);
    setChoosing(false);
    search.clear();
    create.clear();
  };

  const reset = () => {
    setConversation(null);
    setText("");
    setSendError(null);
    setEdit(null);
    clearPlacement();
    save.clear();
    removal.clear();
  };

  const send = async (override?: string) => {
    const message = (override ?? text).trim();
    if (message === "" || message.length > MAX_MESSAGE || sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setSendError(null);
    const result = await safe(() => (conversation ? client.sendConversationMessage(conversation.id, { message }) : client.openConversation(project.id, { message })));
    sendingRef.current = false;
    setSending(false);
    if (result.ok) {
      setConversation(result.data);
      setText("");
      setEdit(null);
      clearPlacement();
      const last = result.data.messages.at(-1);
      setAnnouncement(last?.author === "assistant" ? last.body : "");
      return;
    }
    setSendError(result.error);
    if (result.error.code === "conversation_changed" && conversation) {
      const fresh = await safe(() => client.getConversation(conversation.id));
      if (fresh.ok) {
        setConversation(fresh.data);
        setEdit(null);
        clearPlacement();
      }
    }
  };

  /** Grava a edição à mão do rascunho; devolve a conversa atualizada, ou `null` se falhou. */
  const saveDraft = async (): Promise<ConversationDetail | null> => {
    if (!conversation || !fields) return null;
    const result = await save.run(() => client.updateConversationDraft(conversation.id, { title: fields.title.trim(), description: fields.description }));
    if (!result.ok) return null;
    setConversation(result.data);
    setEdit(null);
    return result.data;
  };

  const searchPlace = async () => {
    if (!conversation || busy) return;
    let current = conversation;
    if (dirty) {
      const saved = await saveDraft();
      if (!saved) return;
      current = saved;
    }
    const result = await search.run(() => client.findPlacement(current.id));
    if (!result.ok) return;
    setPickedNote("");
    setOutcome(result.data);
    setTarget(result.data.destination);
  };

  const createHere = async () => {
    if (!conversation || !target || busy) return;
    let current = conversation;
    if (dirty) {
      const saved = await saveDraft();
      if (!saved) return;
      current = saved;
    }
    const result = await create.run(() => client.createTicketFromConversation(current.id, { parentId: target.parentId }));
    if (!result.ok) return;
    onChanged();
    onCreated(result.data.ticket.id);
  };

  const remove = async () => {
    if (!conversation) return;
    const result = await removal.run(() => client.removeConversation(conversation.id));
    if (result.ok) reset();
  };

  const onTextKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const overLimit = text.length > MAX_MESSAGE;
  const canSend = !sending && text.trim() !== "" && !overLimit;
  const manualParent = target?.parentId ?? null;
  const retryable = sendError !== null && sendError.kind === "unavailable";
  const canCreateManually = retryable || sendError?.code === "assistant_not_configured";
  const up = target ? oneLevelUp(target) : null;
  const options = outcome ? [outcome.destination, ...outcome.alternatives] : [];
  const whereStopped = (parentId: string | null) => (parentId === null ? project.name : list.find((entry) => entry.id === parentId)?.title ?? project.name);

  return (
    <>
      {conversation && (
        <div className="assistant-header-actions" style={{ justifyContent: "flex-end", padding: "6px 12px 0" }}>
          <button type="button" className="text" onClick={reset}>Nova conversa</button>
          <ConfirmAction label="Apagar conversa" disabled={removal.busy} onConfirm={() => void remove()} />
        </div>
      )}
      <div ref={scroller} className="assistant-scroll">
        {removal.error && <p role="alert">{describeApiError(removal.error)}</p>}
        {!conversation && <p className="assistant-hint">Descreva a tarefa. O assistente pergunta o que faltar, escreve o ticket e procura o lugar dele na árvore.</p>}
        {conversation?.messages.map((message) => (
          <div key={message.id} className={message.author === "person" ? "assistant-person" : "assistant-reply"}>{message.body}</div>
        ))}
        {sending && <p role="status" className="assistant-waiting">O assistente está respondendo…</p>}
        {sendError && (
          <div className="assistant-error">
            <p role="alert">{describeApiError(sendError)}</p>
            {(retryable || canCreateManually) && (
              <div>
                {retryable && <button type="button" onClick={() => void send()} disabled={sending}>Tentar de novo</button>}
                <button type="button" onClick={() => onManualCreate({ projectId: project.id, parentId: manualParent, ...(fields ? { draft: { title: fields.title, description: fields.description } } : {}) })}>Criar manualmente</button>
              </div>
            )}
          </div>
        )}
        {draft && fields && (
          <div className="assistant-cards">
            <section className="assistant-card" aria-label="Rascunho do ticket">
              <h3>Rascunho</h3>
              <label>
                Título
                <input value={fields.title} onChange={(event) => setEdit({ ...fields, title: event.target.value })} />
              </label>
              <label>
                Descrição
                <textarea rows={6} value={fields.description} onChange={(event) => setEdit({ ...fields, description: event.target.value })} />
              </label>
              {(save.error || search.error) && <p role="alert">{describeApiError((save.error ?? search.error)!)}</p>}
              {search.busy && <p role="status" className="assistant-hint">Procurando o lugar… a primeira procura em um projeto pode demorar.</p>}
              <div className="assistant-actions">
                {dirty && <button type="button" disabled={save.busy || fields.title.trim() === ""} onClick={() => void saveDraft()}>Salvar rascunho</button>}
                <button type="button" className={outcome ? undefined : "primary"} disabled={busy || fields.title.trim() === ""} onClick={() => void searchPlace()}>
                  {outcome ? "Procurar de novo" : "Procurar o lugar"}
                </button>
              </div>
            </section>
            {outcome && target && (
              <PathCard
                project={project}
                target={target}
                outcome={outcome}
                options={options}
                draftTitle={draft.title}
                canGoUp={up !== null}
                choosing={choosing}
                pickNotice={pickNotice}
                busy={busy}
                error={create.error}
                whereStopped={whereStopped}
                pickedNote={pickedNote}
                onUse={(destination) => {
                  setPickedNote("");
                  setTarget(destination);
                }}
                onUp={() => {
                  setPickedNote("");
                  if (up) setTarget(up);
                }}
                onChoose={() => setChoosing(true)}
                onCancelChoose={() => setChoosing(false)}
                onCreate={() => void createHere()}
              />
            )}
          </div>
        )}
      </div>
      <div className="assistant-visually-hidden" role="status" aria-live="polite" aria-label="Resposta do assistente">{announcement}</div>
      <form className="assistant-form" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <div className="assistant-form-field">
          <label className="assistant-visually-hidden" htmlFor="assistant-message">Mensagem para o assistente</label>
          <textarea
            id="assistant-message"
            autoFocus
            rows={2}
            placeholder="Descreva a tarefa ou responda ao assistente"
            value={text}
            aria-invalid={overLimit ? true : undefined}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onTextKeyDown}
          />
          {text.length >= WARN_AT && (
            <p className={`assistant-count ${overLimit ? "is-over" : ""}`}>
              {overLimit ? `A mensagem passou de 4.000 caracteres (${text.length}). Encurte para enviar.` : `${text.length} de 4.000 caracteres`}
            </p>
          )}
        </div>
        <button type="submit" className="assistant-send" aria-label="Enviar" disabled={!canSend}>
          <SendIcon />
        </button>
      </form>
    </>
  );
}
