import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ApiClient, ApiError, ApiResult, ConversationDetail, DraftPreview, NewGroup, PlacementOutcome, Project, TicketSummary } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { AiIcon } from "../command/icons.js";
import { LoadError } from "../LoadError.js";
import type { MapDraft, MapNode } from "../map/items.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { reopensOnReceiving } from "../ticket/reopen.js";
import { DraftParts, OriginalRequest, samePartList, toPartEdits } from "./DraftPreview.js";
import { DuplicateNotice, RelatedList } from "./RelatedTickets.js";
import type { PartEdit } from "./DraftPreview.js";
import { PathCard } from "./PathCard.js";
import { Reveal } from "./Reveal.js";
import { Skeleton } from "./Skeleton.js";
import { destinationUnder, oneLevelUp } from "./placement.js";
import type { Destination } from "./placement.js";
import type { MapPicker } from "./types.js";
import { RichDescription } from "../ticket/description/RichDescription.js";
import "./assistant.css";
import { ConsentRequiredNotice, isConsentRequired } from "../api/ConsentRequired.js";
import { useDescribeApiError } from "../api/errorText.js";

/** Limite da API para uma mensagem da pessoa (`MAX_PERSON_MESSAGE`). */
export const MAX_MESSAGE = 4000;
const WARN_AT = 3600;

export interface AssistantPanelProps {
  client: ApiClient;
  /** Projetos em que a pessoa pode criar ticket (não arquivados). */
  projects: readonly Project[];
  /** Projeto do ticket ou projeto selecionado; `null` pede a escolha antes da primeira mensagem. */
  initialProjectId: string | null;
  /** Ticket selecionado no mapa ao abrir: a procura começa dentro dele (ADR 0031, ADR 0034). Ignorado se não for ticket do projeto da conversa. */
  initialScopeId?: string | null;
  /** Texto vindo da barra de pedidos (ADR 0036): vai como a primeira mensagem assim que a conversa carrega. */
  initialMessage?: string | null;
  /** Tickets de cada projeto, como o mapa os tem: o painel deriva daqui os caminhos que ele mesmo monta. */
  tickets: Readonly<Record<string, readonly TicketSummary[]>>;
  /** A folha está à vista; falso quando recolhida: a conversa continua montada, só some da barra (ADR 0036). */
  expanded: boolean;
  /** Retoma a conversa aberta mais recente do projeto (`true`) ou começa uma vazia (`false`). */
  resume: boolean;
  /** Recolhe a folha sem encerrar a conversa. */
  onCollapse: () => void;
  /** Diz se há conversa em andamento (mensagem, resposta a caminho ou texto digitado): recolher uma vazia a encerra. */
  onProgress: (active: boolean) => void;
  /** Depois de criar: o mapa recarrega (`onChanged`) e abre a página do ticket novo. */
  onCreated: (ticketId: string) => void;
  /** Abre a página de um ticket que já existe e leva a câmera, SEM fechar o assistente: a prévia fica onde estava. */
  onOpenExisting?: (ticketId: string) => void;
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

/** Folha de conversa para criar ticket com a IA (ADR 0029, ADR 0036): mora dentro da barra de pedidos, com a linha de cima e o corpo. */
export function AssistantPanel(props: AssistantPanelProps) {
  const { projects, initialProjectId, expanded, onCollapse, onProgress } = props;
  const { t } = useTranslation("assistant");
  const body = useRef<HTMLElement>(null);
  const [projectId, setProjectId] = useState(initialProjectId);
  const [choosing, setChoosing] = useState(false);
  const [pickNotice, setPickNotice] = useState("");
  // Lugares da linha de cima que só a conversa sabe preencher (o escopo e as ações dela): ela os alcança por portal.
  const [chipSlot, setChipSlot] = useState<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  // O escopo vive só no estado da folha: não é gravado na conversa, e uma conversa retomada depois começa sem ele.
  const [scopeId, setScopeId] = useState<string | null>(props.initialScopeId ?? null);
  const project = projects.find((entry) => entry.id === projectId) ?? null;
  const scopeTicket = project && scopeId !== null ? (props.tickets[project.id] ?? []).find((entry) => entry.id === scopeId) : undefined;
  const scope = scopeTicket ? { id: scopeTicket.id, key: scopeTicket.key, title: scopeTicket.title } : null;

  useEffect(() => {
    if (project === null) onProgress(false);
  }, [project, onProgress]);

  // O foco entra na folha quando ela abre ou reabre, e volta a ela quando a escolha no mapa termina (o campo de mensagem toma o foco quando existe).
  useEffect(() => {
    if (!expanded || choosing) return;
    const field = body.current?.querySelector<HTMLElement>("#assistant-message");
    (field ?? body.current)?.focus();
  }, [expanded, choosing]);

  return (
    <div className="assistant-sheet" hidden={!expanded}>
      <div className="assistant-top" hidden={choosing}>
        <span className="command-icon"><AiIcon /></span>
        <span ref={setChipSlot} className="assistant-chip-slot" />
        <div className="assistant-title">
          <h2>{t("panel.title")}</h2>
          <p>{project ? t("panel.project", { key: project.key, name: project.name }) : t("panel.subtitle")}</p>
        </div>
        <div ref={setActionsSlot} className="assistant-header-actions" />
        <button type="button" className="assistant-close" aria-label={t("panel.collapse")} onClick={onCollapse}>
          <CloseIcon />
        </button>
      </div>
      {choosing && (
        <div className="assistant-top assistant-pick">
          <span className="command-icon"><AiIcon /></span>
          <div className="assistant-pick-text">
            <p role="status">{t("pick.instruction")}</p>
            {pickNotice !== "" && <p role="alert">{pickNotice}</p>}
          </div>
          <button type="button" className="text" onClick={() => setChoosing(false)}>{t("pick.cancel")}</button>
        </div>
      )}
      <section ref={body} className="assistant-body" aria-label={t("panel.label")} tabIndex={-1} hidden={choosing}>
        {project === null ? (
          <div className="assistant-scroll">
            <h3>{t("project.question")}</h3>
            <ul className="assistant-projects">
              {projects.map((entry) => (
                <li key={entry.id}>
                  <button type="button" onClick={() => setProjectId(entry.id)}>{t("project.option", { key: entry.key, name: entry.name })}</button>
                </li>
              ))}
            </ul>
          </div>
        ) : (
          <ProjectConversation
            key={project.id}
            {...props}
            project={project}
            choosing={choosing}
            setChoosing={setChoosing}
            pickNotice={pickNotice}
            setPickNotice={setPickNotice}
            scope={scope}
            onRemoveScope={() => setScopeId(null)}
            chipSlot={chipSlot}
            actionsSlot={actionsSlot}
          />
        )}
      </section>
    </div>
  );
}

interface ConversationProps extends AssistantPanelProps {
  project: Project;
  choosing: boolean;
  setChoosing: (choosing: boolean) => void;
  pickNotice: string;
  setPickNotice: (notice: string) => void;
  /** Ticket em que a procura começa; `null` procura no projeto inteiro. */
  scope: { id: string; key: string; title: string } | null;
  onRemoveScope: () => void;
  chipSlot: HTMLElement | null;
  actionsSlot: HTMLElement | null;
}

/** Com `resume`, a conversa aberta mais recente da pessoa no projeto continua de onde parou; sem ele, começa vazia. */
function ProjectConversation(props: ConversationProps) {
  if (!props.resume) return <Chat {...props} initial={null} />;
  return <ResumedConversation {...props} />;
}

function ResumedConversation(props: ConversationProps) {
  const { t } = useTranslation("assistant");
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
    return <div className="assistant-scroll"><p role="status" className="assistant-hint">{t("loading")}</p></div>;
  }
  if (loaded.state.status === "error") {
    return <div className="assistant-scroll"><LoadError error={loaded.state.error} onRetry={loaded.retry} /></div>;
  }
  return <Chat {...props} initial={loaded.state.data} />;
}

interface Edit {
  title: string;
  description: string;
  /** Os filhos do rascunho com as edições à mão; vazia quando o rascunho é de um ticket só. */
  children: PartEdit[];
  /** Registrar como ideia ao criar (ADR 0044, adendo). */
  idea: boolean;
}

/** A mensagem que a pessoa acabou de enviar: aparece na conversa antes de a resposta chegar e, se falhar, fica como não respondida. */
interface Outbox {
  text: string;
  /** Abre uma conversa nova (texto da barra) em vez de continuar a que está na folha. */
  fresh: boolean;
  failed: boolean;
}

function Chat(props: ConversationProps & { initial: ConversationDetail | null }) {
  const describeError = useDescribeApiError();
  const { t, i18n } = useTranslation("assistant");
  const language = i18n.language as Language;
  const { client, project, tickets, choosing, setChoosing, setPickNotice, onChanged, onCreated, onOpenExisting, onManualCreate, scope, expanded, onProgress } = props;
  const registerPicker = props.registerPicker;
  const list = tickets[project.id] ?? [];
  const [conversation, setConversation] = useState(props.initial);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ApiError | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [edit, setEdit] = useState<Edit | null>(null);
  const [outbox, setOutbox] = useState<Outbox | null>(null);
  // A resposta que acabou de chegar e ainda está sendo revelada.
  const [revealingId, setRevealingId] = useState<string | null>(null);
  // O que a criação vai gravar, como a API monta; fica o anterior enquanto a nova leitura não volta (a tela não pisca).
  const [preview, setPreview] = useState<DraftPreview | null>(null);
  const [outcome, setOutcome] = useState<PlacementOutcome | null>(null);
  /** A pessoa escolheu "Criar mesmo assim" diante do aviso de duplicado (ADR 0052); vale só para a procura atual. */
  const [duplicateAccepted, setDuplicateAccepted] = useState(false);
  const [searchCount, setSearchCount] = useState(0);
  const [focusCreate, setFocusCreate] = useState(false);
  const [target, setTarget] = useState<Destination | null>(null);
  // A proposta de ticket pai novo (ADR 0031) vale só para o destino da procura: trocar o destino, procurar de novo ou o 409 a descartam.
  const [proposalDropped, setProposalDropped] = useState(false);
  const [unchecked, setUnchecked] = useState<string[]>([]);
  const sendingRef = useRef(false);
  const initialSent = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
  const scrolled = useRef(0);
  const save = useAction();
  const search = useAction();
  const create = useAction();
  const removal = useAction();

  const draft = conversation?.draft ?? null;
  const fields: Edit | null = draft ? edit ?? { title: draft.title, description: draft.description, children: toPartEdits(draft.children), idea: draft.idea } : null;
  const dirty = draft !== null && fields !== null && (fields.title !== draft.title || fields.description !== draft.description || fields.idea !== draft.idea || !samePartList(fields.children, draft.children));
  const blankTitle = fields !== null && (fields.title.trim() === "" || fields.children.some((part) => part.title.trim() === ""));
  const busy = save.busy || search.busy || create.busy || removal.busy;
  const partCount = draft?.children.length ?? 0;

  // A prévia é lida de novo quando o rascunho muda (outra resposta da IA, rascunho salvo à mão).
  const previewKey = conversation && draft ? `${conversation.id}|${conversation.updatedAt}|${JSON.stringify(draft)}` : null;
  useEffect(() => {
    if (previewKey === null || !conversation) {
      setPreview(null);
      return;
    }
    let active = true;
    void safe(() => client.getConversationPreview(conversation.id)).then((result) => {
      if (active) setPreview(result.ok ? result.data : null);
    });
    return () => {
      active = false;
    };
  }, [previewKey]);

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
  }, [conversation?.messages.length, outcome, sendError, outbox, sending, revealingId]);

  // Recolhida, a folha some do layout e a rolagem se perde: ao reabrir, ela volta onde estava.
  useLayoutEffect(() => {
    if (expanded && scroller.current) scroller.current.scrollTop = scrolled.current;
  }, [expanded]);

  // Recolher uma conversa vazia a encerra; com mensagem, resposta a caminho ou texto digitado, ela fica em andamento.
  const active = conversation !== null || sending || outbox !== null || text.trim() !== "";
  useEffect(() => {
    onProgress(active);
  }, [active, onProgress]);

  // "Escolher no mapa": o próximo clique em um ticket ou no projeto do mesmo projeto vira o destino (ADR 0034: qualquer
  // ticket recebe filhos, então o ticket clicado é o destino).
  const register = useRef(registerPicker);
  register.current = registerPicker;
  const pick = useRef<(node: MapNode) => void>(() => undefined);
  pick.current = (node) => {
    const clicked = node.kind === "ticket" && node.ticket?.projectId === project.id ? node.ticket : null;
    const parentId = node.kind === "project" && node.id === project.id ? null : clicked ? clicked.id : undefined;
    if (parentId === undefined) {
      setPickNotice(t("pick.otherProject", { name: project.name }));
      return;
    }
    setTarget(destinationUnder(list, parentId));
    setProposalDropped(true);
    setPickNotice("");
    setChoosing(false);
  };
  useEffect(() => {
    if (!choosing) return;
    setPickNotice("");
    register.current({ pick: (node) => pick.current(node), cancel: () => setChoosing(false) });
    return () => register.current(null);
  }, [choosing, setChoosing, setPickNotice]);

  const clearPlacement = () => {
    setOutcome(null);
    setDuplicateAccepted(false);
    setTarget(null);
    setChoosing(false);
    search.clear();
    create.clear();
  };

  const reset = () => {
    setConversation(null);
    setOutbox(null);
    setRevealingId(null);
    setText("");
    setSendError(null);
    setEdit(null);
    clearPlacement();
    save.clear();
    removal.clear();
  };

  const send = async (override?: string, fresh = false) => {
    const message = (override ?? text).trim();
    if (message === "" || message.length > MAX_MESSAGE || sendingRef.current) return;
    sendingRef.current = true;
    // A mensagem entra na conversa e o campo esvazia antes de a requisição voltar (TREEPM-194).
    setOutbox({ text: message, fresh, failed: false });
    setRevealingId(null);
    if (override === undefined) setText("");
    setSending(true);
    setSendError(null);
    // O escopo vai com a abertura e com cada mensagem (ADR 0033): a IA recebe os tickets com filhos do lugar da procura.
    const scopeId = scope?.id ?? null;
    const result = await safe(() => (conversation && !fresh ? client.sendConversationMessage(conversation.id, { message, scopeId }) : client.openConversation(project.id, { message, scopeId })));
    sendingRef.current = false;
    setSending(false);
    if (result.ok) {
      setConversation(result.data);
      setOutbox(null);
      setEdit(null);
      clearPlacement();
      const last = result.data.messages.at(-1);
      setAnnouncement(last?.author === "assistant" ? last.body : "");
      setRevealingId(last?.author === "assistant" ? last.id : null);
      return;
    }
    // O erro não apaga o que a pessoa enviou: a mensagem fica na conversa, como não respondida, e "Tentar de novo" a reenvia.
    setOutbox({ text: message, fresh, failed: true });
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

  // Texto da barra de pedidos: enviado uma vez, como a primeira mensagem de uma conversa nova.
  const initialMessage = props.initialMessage ?? null;
  useEffect(() => {
    if (initialMessage === null || initialSent.current) return;
    initialSent.current = true;
    // Pedido vindo da barra: sempre uma conversa nova; a anterior continua guardada.
    void send(initialMessage, true);
  }, []);

  /** Grava a edição à mão do rascunho; devolve a conversa atualizada, ou `null` se falhou. */
  const saveDraft = async (): Promise<ConversationDetail | null> => {
    if (!conversation || !fields) return null;
    // Os filhos vão por inteiro quando o rascunho os tem ou os tinha: a lista enviada substitui a anterior (ADR 0044).
    const withParts = fields.children.length > 0 || conversation.draft!.children.length > 0;
    const body = {
      title: fields.title.trim(),
      description: fields.description,
      ...(withParts ? { children: fields.children.map((part) => ({ title: part.title.trim(), description: part.description })) } : {}),
      // A opção só vai quando mudou: sem ela no corpo, a API a mantém como está.
      ...(fields.idea !== conversation.draft!.idea ? { idea: fields.idea } : {}),
    };
    const result = await save.run(() => client.updateConversationDraft(conversation.id, body));
    if (!result.ok) return null;
    // Editar à mão não muda o parecer da IA: vale o `ready` da última resposta (ADR 0033).
    const saved = { ...result.data, ready: conversation.ready };
    setConversation(saved);
    setEdit(null);
    return saved;
  };

  /** `scopeId`: o escopo desta procura (`null`: o projeto inteiro). Devolve se a procura deu resultado. */
  const searchPlace = async (scopeId: string | null = scope?.id ?? null): Promise<boolean> => {
    if (!conversation || busy) return false;
    let current = conversation;
    if (dirty) {
      const saved = await saveDraft();
      if (!saved) return false;
      current = saved;
    }
    setProposalDropped(true);
    const result = await search.run(() => (scopeId === null ? client.findPlacement(current.id) : client.findPlacement(current.id, scopeId)));
    if (!result.ok) return false;
    setProposalDropped(false);
    setUnchecked([]);
    setDuplicateAccepted(false);
    setSearchCount((count) => count + 1);
    setOutcome(result.data);
    setTarget(result.data.destination);
    return true;
  };

  /** Tira o escopo; com um resultado na tela, refaz a procura no projeto inteiro. Se ela falhar, o resultado de escopo sai da tela. */
  const searchWholeProject = async () => {
    props.onRemoveScope();
    if (!outcome) return;
    if (!(await searchPlace(null))) {
      setOutcome(null);
      setTarget(null);
    }
  };

  /** `group`: a proposta confirmada; sem ele, o ticket nasce solto no destino. */
  const createHere = async (group?: NewGroup) => {
    if (!conversation || !target || busy || duplicatePending) return;
    let current = conversation;
    if (dirty) {
      const saved = await saveDraft();
      if (!saved) return;
      current = saved;
    }
    const result = await create.run(() => client.createTicketFromConversation(current.id, group ? { parentId: target.parentId, group } : { parentId: target.parentId }));
    if (!result.ok) {
      // Algum ticket da proposta mudou de lugar: a proposta sai, o resto do card fica.
      if (result.error.code === "grouping_changed") setProposalDropped(true);
      return;
    }
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

  /** Leva a lista ao fim: a resposta que se revela cresce embaixo. */
  const keepEnd = () => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  };

  const overLimit = text.length > MAX_MESSAGE;
  const canSend = !sending && text.trim() !== "" && !overLimit;
  const manualParent = target?.parentId ?? null;
  const retryable = sendError !== null && sendError.kind === "unavailable";
  // Também "a conversa mudou": a mensagem não entrou, e a conversa já foi relida; reenviá-la é o próximo passo natural.
  const canRetry = retryable || sendError?.code === "conversation_changed";
  const canCreateManually = retryable || sendError?.code === "assistant_not_configured" || isConsentRequired(sendError);
  // A prévia recusa a criação (chave que não existe, descrição longa demais): o botão fica desabilitado até o rascunho mudar.
  const duplicatePending = outcome?.duplicate != null && !duplicateAccepted;
  useEffect(() => {
    if (!focusCreate || duplicatePending) return;
    document.querySelector<HTMLButtonElement>("[data-assistant-create]")?.focus();
    setFocusCreate(false);
  }, [focusCreate, duplicatePending]);
  const createBlocked = duplicatePending || (preview !== null && (preview.unknownKeys.length > 0 || preview.descriptionTooLong));
  const up = target ? oneLevelUp(target) : null;
  const options = outcome ? [outcome.destination, ...outcome.alternatives] : [];
  const proposal = outcome && target && !proposalDropped && target.parentId === outcome.destination.parentId ? outcome.groupProposal : null;
  const confirmGroup = () => {
    if (!proposal) return;
    const ticketIds = proposal.tickets.filter((ticket) => !unchecked.includes(ticket.id)).map((ticket) => ticket.id);
    void createHere({ title: proposal.title, description: proposal.description, ticketIds });
  };
  const destination = target?.parentId == null ? null : list.find((entry) => entry.id === target.parentId);
  // Um lugar que já está dentro de uma ideia (ou é a raiz dela): o que nasce ali é parte dela, sem estágio próprio, e a opção some.
  const insideIdea = destination != null && destination.idea != null;
  const asIdea = fields !== null && fields.idea && !insideIdea;
  const reopenKey = destination && reopensOnReceiving(destination) ? destination.key : null;
  const whereStopped = (parentId: string | null) => (parentId === null ? project.name : list.find((entry) => entry.id === parentId)?.title ?? project.name);

  return (
    <>
      {props.chipSlot && scope && createPortal(
        <span className="command-chip" title={scope.title}>
          {t("scope.chip", { key: scope.key })}
          <button type="button" aria-label={t("scope.remove")} disabled={busy} onClick={() => void searchWholeProject()}>×</button>
        </span>,
        props.chipSlot,
      )}
      {props.actionsSlot && conversation && createPortal(
        <>
          <button type="button" className="text" onClick={reset}>{t("conversation.new")}</button>
          <ConfirmAction label={t("conversation.delete")} disabled={removal.busy} onConfirm={() => void remove()} />
        </>,
        props.actionsSlot,
      )}
      <div ref={scroller} className="assistant-scroll" onScroll={(event) => { if (expanded) scrolled.current = event.currentTarget.scrollTop; }}>
        {removal.error && <p role="alert">{describeError(removal.error)}</p>}
        {!conversation && !outbox && <p className="assistant-hint">{t("conversation.hint")}</p>}
        {conversation?.messages.map((message) =>
          message.author === "person" ? (
            <div key={message.id} className="assistant-person">{message.body}</div>
          ) : (
            <Reveal key={message.id} text={message.body} active={message.id === revealingId} onDone={() => setRevealingId((current) => (current === message.id ? null : current))} onStep={() => keepEnd()}>
              {(shown, revealing) => <div className="assistant-reply" aria-hidden={revealing ? true : undefined}>{shown}</div>}
            </Reveal>
          ),
        )}
        {outbox && (
          <div className={`assistant-person ${outbox.failed ? "is-unanswered" : ""}`}>
            {outbox.text}
            {outbox.failed && <small className="assistant-unanswered">{t("conversation.unanswered")}</small>}
          </div>
        )}
        {sending && (
          <>
            <p role="status" className="assistant-waiting">{t("conversation.waiting")}</p>
            <Skeleton />
          </>
        )}
        {sendError && (
          <div className="assistant-error">
            {isConsentRequired(sendError) ? <ConsentRequiredNotice /> : <p role="alert">{describeError(sendError)}</p>}
            {(canRetry || canCreateManually) && (
              <div>
                {canRetry && <button type="button" onClick={() => void (outbox ? send(outbox.text, outbox.fresh) : send())} disabled={sending}>{t("error.retry")}</button>}
                <button type="button" onClick={() => onManualCreate({ projectId: project.id, parentId: manualParent, ...(fields ? { draft: { title: fields.title, description: fields.description } } : {}) })}>{t("error.manual")}</button>
              </div>
            )}
          </div>
        )}
        {draft && fields && (
          <div className="assistant-cards">
            {preview && preview.quote !== "" && <OriginalRequest quote={preview.quote} mentions={{ projectId: project.id, tickets: list }} />}
            <section className="assistant-card" aria-label={t("draft.region")}>
              <h3>{t("draft.heading")}</h3>
              <label>
                {t("draft.title")}
                <input value={fields.title} onChange={(event) => setEdit({ ...fields, title: event.target.value })} />
              </label>
              <div className="assistant-field">
                <span>{t("draft.description")}</span>
                <RichDescription
                  className="is-field"
                  value={fields.description}
                  editing
                  canEdit
                  label={t("draft.description")}
                  placeholder=""
                  mentions={{ projectId: project.id, tickets: props.tickets[project.id] ?? [] }}
                  onChange={(text) => setEdit({ ...fields, description: text })}
                />
              </div>
              {fields.children.length > 0 || partCount > 0 ? (
                <DraftParts parts={fields.children} mentions={{ projectId: project.id, tickets: list }} disabled={save.busy} onChange={(children) => setEdit({ ...fields, children })} />
              ) : null}
              {!insideIdea && (
                <div className="assistant-idea-option">
                  <label>
                    <input type="checkbox" checked={fields.idea} disabled={busy} aria-describedby="assistant-idea-hint" onChange={(event) => setEdit({ ...fields, idea: event.target.checked })} />
                    {t("draft.idea.label")}
                  </label>
                  <small id="assistant-idea-hint">{t("draft.idea.hint")}</small>
                </div>
              )}
              {preview && preview.unknownKeys.length > 0 && <p role="alert" className="assistant-warning">{t("draft.warning.unknownKeys", { keys: preview.unknownKeys.join(", ") })}</p>}
              {preview?.descriptionTooLong === true && <p role="alert" className="assistant-warning">{t("draft.warning.tooLong")}</p>}
              {(save.error || search.error) && <p role="alert">{describeError((save.error ?? search.error)!)}</p>}
              {search.busy && <p role="status" className="assistant-hint">{t("draft.searching")}</p>}
              {!conversation!.ready && !outcome && <p className="assistant-hint assistant-not-ready">{t("draft.notReady")}</p>}
              <div className="assistant-actions">
                {dirty && <button type="button" disabled={save.busy || blankTitle} onClick={() => void saveDraft()}>{t("draft.save")}</button>}
                <button type="button" className={outcome || !conversation!.ready ? undefined : "primary"} disabled={busy || blankTitle} onClick={() => void searchPlace()}>
                  {outcome ? t("draft.searchAgain") : conversation!.ready ? t("draft.search") : t("draft.searchAnyway")}
                </button>
              </div>
            </section>
            {outcome?.duplicate && !duplicateAccepted && (
              <DuplicateNotice duplicate={outcome.duplicate} announceKey={searchCount} onOpen={() => (onOpenExisting ?? onCreated)(outcome.duplicate!.id)} onCreateAnyway={() => { setDuplicateAccepted(true); setFocusCreate(true); }} />
            )}
            {outcome && target && (
              <PathCard
                project={project}
                target={target}
                outcome={outcome}
                options={options}
                draftTitle={draft.title}
                canGoUp={up !== null}
                busy={busy}
                error={create.error}
                whereStopped={whereStopped}
                reopensKey={reopenKey}
                outOfScope={scope && outcome.scope?.outOfScope && outcome.scope.id === scope.id ? { title: scope.title } : null}
                onWholeProject={() => void searchWholeProject()}
                proposal={proposal}
                unchecked={unchecked}
                onToggle={(ticketId) => setUnchecked((current) => (current.includes(ticketId) ? current.filter((id) => id !== ticketId) : [...current, ticketId]))}
                onCreateGroup={confirmGroup}
                onUse={(destination) => {
                  setProposalDropped(true);
                  setTarget(destination);
                }}
                onUp={() => {
                  setProposalDropped(true);
                  if (up) setTarget(up);
                }}
                onChoose={() => setChoosing(true)}
                onCreate={() => void createHere()}
                parts={partCount}
                idea={asIdea}
                createBlocked={createBlocked}
              />
            )}
            {outcome && <RelatedList related={outcome.related} onOpen={onOpenExisting ?? onCreated} />}
          </div>
        )}
      </div>
      <div className="assistant-visually-hidden" role="status" aria-live="polite" aria-label={t("conversation.reply")}>{announcement}</div>
      <form className="assistant-form" onSubmit={(event) => { event.preventDefault(); void send(); }}>
        <div className="assistant-form-field">
          <label className="assistant-visually-hidden" htmlFor="assistant-message">{t("message.label")}</label>
          <textarea
            id="assistant-message"
            autoFocus
            rows={2}
            placeholder={t("message.placeholder")}
            value={text}
            aria-invalid={overLimit ? true : undefined}
            onChange={(event) => setText(event.target.value)}
            onKeyDown={onTextKeyDown}
          />
          {text.length >= WARN_AT && (
            <p className={`assistant-count ${overLimit ? "is-over" : ""}`}>
              {overLimit ? t("message.over", { max: formatNumber(language, MAX_MESSAGE), length: text.length }) : t("message.within", { max: formatNumber(language, MAX_MESSAGE), length: text.length })}
            </p>
          )}
        </div>
        <button type="submit" className="assistant-send" aria-label={t("message.send")} disabled={!canSend}>
          <SendIcon />
        </button>
      </form>
    </>
  );
}
