import { useEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import type { ApiError, ConversationDetail, CreatedFromConversation, DraftPreview, ElaborationOutcome, NewGroup, PlacedBy, PlacementOutcome } from "../api/client.js";
import type { MapNode } from "../map/items.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { useTranslation } from "react-i18next";
import { formatNumber } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { reopensOnReceiving } from "../ticket/reopen.js";
import { DraftParts, OriginalRequest, samePartList, toPartEdits } from "./DraftPreview.js";
import { CreatedNotice, ElaborationAnnouncement, ElaborationLoading, LinksGroup, SuggestedGroup, linkId, normalizeTitle } from "./Elaboration.js";
import type { LinkRow } from "./Elaboration.js";
import { DuplicateNotice, RelatedList } from "./RelatedTickets.js";
import type { PartEdit } from "./DraftPreview.js";
import { PathCard } from "./PathCard.js";
import type { QuestionView } from "./PathCard.js";
import { useRecentPlaces } from "./RecentPlacesContext.js";
import { Reveal } from "./Reveal.js";
import { Skeleton } from "./Skeleton.js";
import { destinationUnder, oneLevelUp, recentChoices } from "./placement.js";
import type { Destination, PlaceChoice } from "./placement.js";
import { RichDescription } from "../ticket/description/RichDescription.js";
import "./assistant.css";
import { ConsentRequiredNotice, isConsentRequired } from "../api/ConsentRequired.js";
import { useDescribeApiError } from "../api/errorText.js";
import type { ApiClient, Project, TicketSummary } from "../api/client.js";
import type { MapDraft } from "../map/items.js";
import type { MapPicker } from "./types.js";

export interface ConversationProps {
  client: ApiClient;
  /** Projetos em que a pessoa pode criar ticket (não arquivados). */
  projects: readonly Project[];
  project: Project;
  /** Tickets de cada projeto, como o mapa os tem: a conversa deriva daqui os caminhos que ela mesma monta. */
  tickets: Readonly<Record<string, readonly TicketSummary[]>>;
  /** Depois de criar: o mapa recarrega (`onChanged`) e abre a página do ticket novo. */
  onCreated: (ticketId: string) => void;
  /** Abre a página de um ticket que já existe e leva a câmera, SEM sair da conversa. */
  onOpenExisting?: (ticketId: string) => void;
  /** Caminho de saída quando a IA falha: o modo de criação manual da página do ticket. */
  /** Há onde abrir a criação manual (a página do ticket, no mapa); sem isso o botão "Criar manualmente" não aparece. */
  canManualCreate?: boolean;
  onManualCreate: (request: { projectId: string; parentId: string | null; draft?: { title: string; description: string } }) => void;
  /** Onde o mapa mostra o card tracejado; `null` quando não há destino. */
  onDraftChange: (draft: MapDraft | null) => void;
  onChanged: () => void;
  /** Enquanto a pessoa "escolhe no mapa", o mapa envia os cliques em nós a este objeto. */
  registerPicker: (picker: MapPicker | null) => void;
  /** Há um mapa montado onde escolher o lugar; falso em outra tela, e o botão "Escolher no mapa" não aparece. */
  canPickOnMap: boolean;
  choosing: boolean;
  setChoosing: (choosing: boolean) => void;
  pickNotice: string;
  setPickNotice: (notice: string) => void;
  /** Ticket em que a procura começa; `null` procura no projeto inteiro. */
  scope: { id: string; key: string; title: string } | null;
  onRemoveScope: () => void;
  chipSlot: HTMLElement | null;
  actionsSlot: HTMLElement | null;
  /** A thread some depois de descartar; quem hospeda decide para onde ir. */
  onRemoved: () => void;
  /** A conversa mudou de estado (mensagem, procura, resposta, rascunho salvo); a barra lateral relê o selo. */
  onActivity?: () => void;
  /** O que a tela guardou da última vez que esta thread esteve aberta (memória da sessão), e quem o guarda ao sair. */
  memory?: ChatScreenState;
  onRemember?: (screen: ChatScreenState) => void;
  /** O resultado da última procura, remontado do que o servidor guarda; a tela volta a ele ao reabrir. */
  initialOutcome?: PlacementOutcome | null;
  /** A criação seguiu mas a API descartou ligações ou sugeridas: quem hospeda guarda o aviso, porque a thread vira "criada" e este miolo desmonta. */
  onNotice?: (notice: { ticketId: string; warnings: CreatedFromConversation["warnings"] }) => void;
}

/** O que só a tela sabe de uma thread de criação (o servidor não guarda): vive na memória da sessão e volta quando a thread reabre. */
export interface ChatScreenState {
  text: string;
  edit: Edit | null;
  target: Destination | null;
  placedBy: PlacedBy;
  trail: Trail;
  limitReached: boolean;
  proposalDropped: boolean;
  unchecked: string[];
  duplicateAccepted: boolean;
  removedSuggested: string[];
  uncheckedLinks: string[];
  scopeRemoved: boolean;
}

/** Limite da API para uma mensagem da pessoa (`MAX_PERSON_MESSAGE`). */
export const MAX_MESSAGE = 4000;
const WARN_AT = 3600;

const SendIcon = () => (
  <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
    <path d="M8 13V3M3.5 7.5 8 3l4.5 4.5" />
  </svg>
);

export interface Edit {
  title: string;
  description: string;
  /** Os filhos do rascunho com as edições à mão; vazia quando o rascunho é de um ticket só. */
  children: PartEdit[];
  /** Registrar como ideia ao criar (ADR 0044, adendo). */
  idea: boolean;
}

/** Quantas respostas a pessoa dá à pergunta nesta procura antes de a tela parar de perguntar (ADR 0054, item 4): conforto, não segurança. */
export const MAX_ANSWERS = 3;

/** As respostas da pessoa nesta procura: quantas, o último ramo que ela confirmou e de que tipo foi a primeira. */
export interface Trail {
  answers: number;
  branch: string | null;
  first: "option" | "recent" | null;
}
const NO_TRAIL: Trail = { answers: 0, branch: null, first: null };

/** A mensagem que a pessoa acabou de enviar: aparece na conversa antes de a resposta chegar e, se falhar, fica como não respondida. */
interface Outbox {
  text: string;
  failed: boolean;
}

export function Chat(props: ConversationProps & { initial: ConversationDetail | null }) {
  const describeError = useDescribeApiError();
  const { t, i18n } = useTranslation("assistant");
  const language = i18n.language as Language;
  const { client, project, tickets, choosing, setChoosing, setPickNotice, onChanged, onCreated, onOpenExisting, onManualCreate, scope } = props;
  const registerPicker = props.registerPicker;
  const list = tickets[project.id] ?? [];
  const [conversation, setConversation] = useState(props.initial);
  const memory = props.memory;
  const [text, setText] = useState(memory?.text ?? "");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<ApiError | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [edit, setEdit] = useState<Edit | null>(memory?.edit ?? null);
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
  // De que tipo foi a escolha do destino (ADR 0054, adendo): o que a procura confirmou, ou o que a pessoa escolheu. Com a pergunta
  // aberta não há destino nem criação; um resultado sem pergunta e sem confirmação (decisão não guardada) vale como opção.
  const [placedBy, setPlacedBy] = useState<PlacedBy>("search");
  // As respostas da pessoa à pergunta nesta procura; recomeçam a cada procura nova. O teto de três vale na tela.
  const trail = useRef<Trail>(memory?.trail ?? NO_TRAIL);
  // Cada procura leva um número; o resultado de uma procura superada (a pessoa agiu depois de ela sair) é descartado.
  const searchSeq = useRef(0);
  // A pessoa tirou o escopo: as procuras seguintes vão com `scopeId: null` explícito (ausente, o servidor reaplicaria o ticket de origem da thread).
  const scopeRemoved = useRef(memory?.scopeRemoved ?? false);
  const scopeArg = (): string | null | undefined => (scope ? scope.id : scopeRemoved.current ? null : undefined);
  const inFlight = useRef(false);
  const [limitReached, setLimitReached] = useState(false);
  const recents = useRecentPlaces();
  // A proposta de ticket pai novo (ADR 0031) vale só para o destino da procura: trocar o destino, procurar de novo ou o 409 a descartam.
  const [proposalDropped, setProposalDropped] = useState(false);
  const [unchecked, setUnchecked] = useState<string[]>([]);
  // A elaboração (ADR 0052, item 4): chega depois da procura, sem bloquear a prévia. O que a pessoa tirou fica guardado na conversa.
  const [elaboration, setElaboration] = useState<ElaborationOutcome | null>(null);
  const [elaborationLoading, setElaborationLoading] = useState(false);
  /** O rascunho (salvo) para o qual a elaboração foi pedida: se ele mudou desde então, a elaboração é velha e não vale. */
  const [elaboratedFor, setElaboratedFor] = useState<string | null>(null);
  /** A criação seguiu, mas a API descartou ligações ou sugeridas: a tela diz o que ficou de fora antes de abrir o ticket. */
  const [createdNotice, setCreatedNotice] = useState<{ ticketId: string; warnings: CreatedFromConversation["warnings"] } | null>(null);
  const [removedSuggested, setRemovedSuggested] = useState<string[]>(memory?.removedSuggested ?? []);
  const [uncheckedLinks, setUncheckedLinks] = useState<string[]>(memory?.uncheckedLinks ?? []);
  const sendingRef = useRef(false);
  const scroller = useRef<HTMLDivElement>(null);
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

  // Trocar de conversa desmonta esta tela: o que só ela sabe fica na memória da sessão, por thread, e volta ao reabrir.
  const latest = useRef<ChatScreenState | null>(null);
  latest.current = { text, edit, target, placedBy, trail: trail.current, limitReached, proposalDropped, unchecked, duplicateAccepted, removedSuggested, uncheckedLinks, scopeRemoved: scopeRemoved.current };
  const onRemember = useRef(props.onRemember);
  onRemember.current = props.onRemember;
  useEffect(() => () => void (latest.current && onRemember.current?.(latest.current)), []);
  // A pergunta aberta (ou o destino confirmado) vem do servidor; o que a pessoa fez depois dela, da memória.
  useEffect(() => {
    const restored = props.initialOutcome;
    if (!restored) return;
    showOutcome(restored, trail.current);
    if (memory) {
      setTarget(memory.target);
      setPlacedBy(memory.placedBy);
      setLimitReached(memory.limitReached);
      setProposalDropped(memory.proposalDropped);
      setUnchecked(memory.unchecked);
      setDuplicateAccepted(memory.duplicateAccepted);
    }
  }, []);

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

  // Uma elaboração por procura: só depois de a procura terminar (há resultado na tela), e não de novo quando o rascunho é salvo.
  // Rascunho que mudou depois dela deixa a elaboração velha: ela some e a pessoa procura de novo.
  const draftKey = draft ? JSON.stringify(draft) : null;
  // Com a pergunta aberta não há destino: a elaboração espera a pessoa escolher o lugar.
  const elaborationKey = outcome && target ? searchCount : null;
  const draftKeyNow = useRef(draftKey);
  draftKeyNow.current = draftKey;
  useEffect(() => {
    setElaboration(null);
    if (elaborationKey === null || !conversation) {
      setElaborationLoading(false);
      return;
    }
    let live = true;
    setElaborationLoading(true);
    const asked = draftKeyNow.current;
    void safe(() => client.getElaboration(conversation.id)).then((result) => {
      if (!live) return;
      setElaboration(result.ok ? result.data : null);
      setElaboratedFor(asked);
      setElaborationLoading(false);
    });
    return () => {
      live = false;
    };
  }, [elaborationKey]);

  const stale = elaboration !== null && (dirty || elaboratedFor !== draftKey);
  const shown = stale ? null : elaboration;
  const hadSuggestions = elaboration !== null && elaboration.suggested.length + elaboration.links.length > 0;
  const keptSuggested = (shown?.suggested ?? []).filter((task) => !removedSuggested.includes(normalizeTitle(task.title)));
  const linkRows: LinkRow[] = (shown?.links ?? []).flatMap((link) => {
    // A parte de origem é achada pelo título (o índice da elaboração pode estar velho); sem parte com esse título, a ligação não vale.
    const index = link.de === "pai" ? "pai" : (draft?.children ?? []).findIndex((child) => normalizeTitle(child.title) === normalizeTitle(link.deTitle ?? ""));
    if (index === -1) return [];
    const part = index === "pai" ? null : draft!.children[index]!.title;
    const ticketId = outcome?.related.find((item) => item.key === link.dependeDe)?.id ?? list.find((item) => item.key === link.dependeDe)?.id ?? null;
    return [{ link, index, part, ticketId, checked: !uncheckedLinks.includes(linkId(link)) }];
  });
  const keptLinks = linkRows.filter((row) => row.checked).map((row) => ({ de: row.index, ...(row.part === null ? {} : { deTitle: row.part }), dependeDe: row.link.dependeDe }));
  const waitingElaboration = outcome !== null && elaborationLoading;

  // O card tracejado do mapa segue o destino e o título salvo do rascunho.
  const onDraftChange = useRef(props.onDraftChange);
  onDraftChange.current = props.onDraftChange;
  const ghostTitle = draft?.title ?? null;
  const ghostParent = target === null ? undefined : target.parentId;
  useEffect(() => {
    onDraftChange.current(ghostParent === undefined || ghostTitle === null ? null : { projectId: project.id, parentId: ghostParent, title: ghostTitle });
    // O mapa que remonta traz outro `onDraftChange`: o card tracejado volta nele.
  }, [ghostParent, ghostTitle, project.id, props.onDraftChange]);
  useEffect(() => () => onDraftChange.current(null), []);

  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [conversation?.messages.length, outcome, sendError, outbox, sending, revealingId]);

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
    searchSeq.current += 1;
    setLimitReached(false);
    setTarget(destinationUnder(list, parentId));
    setPlacedBy("map");
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
    setElaboration(null);
    setCreatedNotice(null);
    setDuplicateAccepted(false);
    setTarget(null);
    setChoosing(false);
    trail.current = NO_TRAIL;
    searchSeq.current += 1;
    setLimitReached(false);
    search.clear();
    create.clear();
  };

  const send = async (override?: string) => {
    const message = (override ?? text).trim();
    if (message === "" || message.length > MAX_MESSAGE || sendingRef.current) return;
    sendingRef.current = true;
    // A mensagem entra na conversa e o campo esvazia antes de a requisição voltar (TREEPM-194).
    setOutbox({ text: message, failed: false });
    setRevealingId(null);
    if (override === undefined) setText("");
    setSending(true);
    setSendError(null);
    // O escopo vai com a abertura e com cada mensagem (ADR 0033): a IA recebe os tickets com filhos do lugar da procura.
    const scopeId = scope?.id ?? null;
    const result = await safe(() => (conversation ? client.sendConversationMessage(conversation.id, { message, scopeId }) : client.openConversation(project.id, { message, scopeId })));
    sendingRef.current = false;
    setSending(false);
    if (result.ok) {
      setConversation(result.data);
      setOutbox(null);
      setEdit(null);
      clearPlacement();
      props.onActivity?.();
      const last = result.data.messages.at(-1);
      setAnnouncement(last?.author === "assistant" ? last.body : "");
      setRevealingId(last?.author === "assistant" ? last.id : null);
      return;
    }
    // O erro não apaga o que a pessoa enviou: a mensagem fica na conversa, como não respondida, e "Tentar de novo" a reenvia.
    setOutbox({ text: message, failed: true });
    setSendError(result.error);
    if (result.error.code === "conversation_changed" && conversation) {
      const reloaded = await safe(() => client.getConversation(conversation.id));
      if (reloaded.ok) {
        setConversation(reloaded.data);
        setEdit(null);
        clearPlacement();
      }
    }
  };

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
    props.onActivity?.();
    return saved;
  };

  /** Põe na tela o resultado de uma procura, com as respostas que a pessoa deu até aqui (ADR 0054). */
  const showOutcome = (data: PlacementOutcome, answered: Trail) => {
    setProposalDropped(false);
    setUnchecked([]);
    setDuplicateAccepted(false);
    setSearchCount((count) => count + 1);
    setOutcome(data);
    const stopAsking = data.question !== null && answered.answers >= MAX_ANSWERS && answered.branch !== null;
    // Sem decisão guardada e com o palpite na raiz: só a pessoa pode pôr o ticket ali, então a tela pergunta (ADR 0054, revisão 1).
    const rootGuess = data.question === null && !data.destinationConfirmed && data.destination.parentId === null;
    // Teto: o destino é o último ramo que a pessoa confirmou, sem proposta de agrupador (ela vem do palpite).
    if (stopAsking) setProposalDropped(true);
    setLimitReached(stopAsking);
    setTarget(stopAsking ? destinationUnder(list, answered.branch) : data.question !== null || rootGuess ? null : data.destination);
    setPlacedBy(answered.answers > 0 ? answered.first ?? "option" : data.destinationConfirmed ? "search" : "option");
    // O lugar fechou (resposta que confirma, teto, palpite fora da raiz): o foco vai ao botão de criar.
    if (stopAsking || (data.question === null && !rootGuess && answered.answers > 0)) setFocusCreate(true);
  };

  /** O lugar na tela é uma escolha da pessoa (ramo, "fica aqui", recente, mapa, alternativa)? Então a edição do rascunho não o invalida. */
  const chosenPlace = target !== null && placedBy !== "search";

  /** `scopeId`: o escopo desta procura (`null`: o projeto inteiro). Procura nova: as respostas recomeçam. Devolve se deu resultado. */
  const searchPlace = async (scopeId: string | null | undefined = scopeArg()): Promise<boolean> => {
    if (!conversation || busy) return false;
    let current = conversation;
    if (dirty) {
      const saved = await saveDraft();
      if (!saved) return false;
      current = saved;
    }
    return searchFrom(current, scopeId);
  };

  /** A procura nova de um rascunho já salvo. */
  const searchFrom = async (current: ConversationDetail, scopeId: string | null | undefined): Promise<boolean> => {
    setProposalDropped(true);
    const seq = ++searchSeq.current;
    const result = await search.run(() => (scopeId === undefined ? client.findPlacement(current.id) : client.findPlacement(current.id, scopeId)));
    if (!result.ok || seq !== searchSeq.current) return false;
    trail.current = NO_TRAIL;
    showOutcome(result.data, NO_TRAIL);
    props.onActivity?.();
    return true;
  };

  /** Salva o rascunho. O lugar que veio da procura vale para o texto de antes: procura de novo. A escolha da pessoa fica. */
  const saveAndSearchAgain = async () => {
    if (!conversation || busy) return;
    const saved = await saveDraft();
    if (saved && outcome !== null && !chosenPlace) await searchFrom(saved, scopeArg());
  };

  /** A pessoa respondeu à pergunta com um ramo ou um lugar recente: a procura continua a partir dele. */
  const answer = async (choice: PlaceChoice, kind: "option" | "recent") => {
    if (!conversation || busy || inFlight.current) return;
    // Rascunho com edição não salva: o lugar de antes já não vale; salvar procura de novo, do zero.
    if (dirty) return void (await saveAndSearchAgain());
    const answered: Trail = { answers: trail.current.answers + 1, branch: choice.id, first: trail.current.first ?? kind };
    const scopeId = scopeArg();
    const seq = ++searchSeq.current;
    inFlight.current = true;
    const result = await search.run(() => client.findPlacement(conversation.id, scopeId, choice.id));
    inFlight.current = false;
    // A pessoa agiu depois de a procura sair (mensagem, rascunho, nova procura): a resposta velha não troca destino nem `placedBy`.
    if (!result.ok || seq !== searchSeq.current) return;
    trail.current = answered;
    showOutcome(result.data, answered);
    props.onActivity?.();
  };

  /** "Fica aqui" (na raiz: solto): o destino é o nó da pergunta, com o caminho que o servidor mandou. */
  const stay = () => {
    if (!outcome || busy || inFlight.current) return;
    const at = outcome.question?.at ?? { id: null, path: [] };
    searchSeq.current += 1;
    setProposalDropped(true);
    setLimitReached(false);
    setTarget({ parentId: at.id, path: at.path.map((step) => ({ id: step.id, title: step.title })) });
    setPlacedBy("stay");
    setFocusCreate(true);
  };

  /** Tira o escopo; com um resultado na tela, refaz a procura no projeto inteiro. Se ela falhar, o resultado de escopo sai da tela. */
  const searchWholeProject = async () => {
    scopeRemoved.current = true;
    props.onRemoveScope();
    if (!outcome) return;
    if (!(await searchPlace(null))) {
      setOutcome(null);
      setTarget(null);
    }
  };

  /** `group`: a proposta confirmada; sem ele, o ticket nasce solto no destino. */
  const createHere = async (group?: NewGroup, withoutElaboration = false) => {
    if (!conversation || !target || busy || duplicatePending) return;
    // O rascunho mudou desde a procura: salvar procura de novo, e a pessoa confere o lugar antes de criar.
    let current = conversation;
    if (dirty) {
      // O lugar da procura vale para o texto de antes: salvar procura de novo e a pessoa confere. Uma escolha dela fica e cria já.
      if (!chosenPlace) return void (await saveAndSearchAgain());
      const saved = await saveDraft();
      if (!saved) return;
      current = saved;
    }
    const result = await create.run(() => client.createTicketFromConversation(current.id, {
        parentId: target.parentId,
        placedBy,
        ...(group ? { group } : {}),
        ...(!withoutElaboration && keptSuggested.length > 0 ? { suggested: keptSuggested } : {}),
        ...(!withoutElaboration && keptLinks.length > 0 ? { links: keptLinks } : {}),
      }),
    );
    if (!result.ok) {
      // Algum ticket da proposta mudou de lugar: a proposta sai, o resto do card fica.
      if (result.error.code === "grouping_changed") setProposalDropped(true);
      // A procura guardada não vale mais para este rascunho (ADR 0054): procura de novo.
      if (result.error.code === "placement_stale") void searchPlace().then((found) => { if (found) create.clear(); });
      return;
    }
    // O pai real do ticket criado (com agrupador, é o agrupador), não o destino pedido.
    if (result.data.ticket.parentId !== null) recents.record(project.id, result.data.ticket.parentId);
    if (result.data.warnings.length > 0) {
      const notice = { ticketId: result.data.ticket.id, warnings: result.data.warnings };
      setCreatedNotice(notice);
      props.onNotice?.(notice);
      onChanged();
      return;
    }
    onChanged();
    onCreated(result.data.ticket.id);
  };

  const remove = async () => {
    if (!conversation) return;
    const result = await removal.run(() => client.removeConversation(conversation.id));
    if (!result.ok) return;
    props.onRemoved();
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
  /** Sem mapa montado não há onde abrir a criação manual. */
  const manualAvailable = props.canManualCreate !== false;
  // A prévia recusa a criação (chave que não existe, descrição longa demais): o botão fica desabilitado até o rascunho mudar.
  const duplicatePending = outcome?.duplicate != null && !duplicateAccepted;
  useEffect(() => {
    if (!focusCreate || duplicatePending) return;
    document.querySelector<HTMLButtonElement>("[data-assistant-create]")?.focus();
    setFocusCreate(false);
  }, [focusCreate, duplicatePending]);
  const createBlocked = duplicatePending || (preview !== null && (preview.unknownKeys.length > 0 || preview.descriptionTooLong));
  const up = target ? oneLevelUp(target) : null;
  // O palpite do servidor só vira opção quando não há pergunta (com pergunta, a pessoa escolhe entre as opções dela).
  const options = outcome && outcome.question === null ? [outcome.destination, ...outcome.alternatives] : [];
  const questionView = useMemo<QuestionView | null>(
    () =>
      outcome && target === null
        ? outcome.question
          ? { at: outcome.question.at, options: outcome.question.options, recents: recentChoices(list, recents.read(project.id), outcome.question, scope?.id ?? null) }
          : { at: { id: null, title: project.name, path: [] }, options: [], recents: [] }
        : null,
    [outcome, target, list, recents, project.id, project.name, scope?.id],
  );
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
          <ConfirmAction label={t("conversation.discard")} disabled={removal.busy} onConfirm={() => void remove()} />
        </>,
        props.actionsSlot,
      )}
      <div ref={scroller} className="assistant-scroll">
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
            {(canRetry || (canCreateManually && manualAvailable)) && (
              <div>
                {canRetry && <button type="button" onClick={() => void (outbox ? send(outbox.text) : send())} disabled={sending}>{t("error.retry")}</button>}
                {manualAvailable && <button type="button" onClick={() => onManualCreate({ projectId: project.id, parentId: manualParent, ...(fields ? { draft: { title: fields.title, description: fields.description } } : {}) })}>{t("error.manual")}</button>}
              </div>
            )}
          </div>
        )}
        {draft && fields && (
          <div className="assistant-cards">
            {preview && preview.quote !== "" && <OriginalRequest quote={preview.quote} mentions={{ projectId: project.id, tickets: list }} />}
            <section className="assistant-card is-draft" aria-label={t("draft.region")}>
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
                {dirty && <button type="button" disabled={save.busy || blankTitle} onClick={() => void saveAndSearchAgain()}>{t("draft.save")}</button>}
                <button type="button" className={outcome || !conversation!.ready ? undefined : "primary"} disabled={busy || blankTitle} onClick={() => void searchPlace()}>
                  {outcome ? t("draft.searchAgain") : conversation!.ready ? t("draft.search") : t("draft.searchAnyway")}
                </button>
              </div>
            </section>
            {createdNotice && <CreatedNotice notice={createdNotice} onOpen={() => onCreated(createdNotice.ticketId)} />}
            {!createdNotice && outcome?.duplicate && !duplicateAccepted && (
              <DuplicateNotice duplicate={outcome.duplicate} announceKey={searchCount} onOpen={() => (onOpenExisting ?? onCreated)(outcome.duplicate!.id)} onCreateAnyway={() => { setDuplicateAccepted(true); setFocusCreate(true); }} />
            )}
            {!createdNotice && outcome && (target || questionView) && (
              <PathCard
                project={project}
                ticketOf={(id) => list.find((entry) => entry.id === id)}
                target={target}
                question={questionView}
                questionKey={searchCount}
                onAnswer={(choice, kind) => void answer(choice, kind)}
                onStay={stay}
                limitReached={limitReached}
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
                  searchSeq.current += 1;
                  setLimitReached(false);
                  setProposalDropped(true);
                  setTarget(destination);
                  setPlacedBy("option");
                }}
                onUp={() => {
                  searchSeq.current += 1;
                  setLimitReached(false);
                  setProposalDropped(true);
                  if (up) setTarget(up);
                  setPlacedBy("option");
                }}
                onChoose={props.canPickOnMap ? () => setChoosing(true) : undefined}
                onCreate={() => void createHere()}
                waiting={waitingElaboration}
                onCreateNow={() => void createHere(undefined, true)}
                parts={partCount}
                idea={asIdea}
                createBlocked={createBlocked}
              />
            )}
            {!createdNotice && outcome && <ElaborationAnnouncement suggested={shown?.suggested.length ?? 0} links={shown?.links.length ?? 0} />}
            {!createdNotice && waitingElaboration && <ElaborationLoading />}
            {!createdNotice && outcome && stale && hadSuggestions && <p className="assistant-hint assistant-elaboration-stale">{t("elaboration.stale")}</p>}
            <SuggestedGroup
              tasks={createdNotice ? [] : keptSuggested}
              onRemove={(task) => {
                if (keptSuggested.length === 1) setFocusCreate(true);
                setRemovedSuggested((current) => [...current, normalizeTitle(task.title)]);
              }}
              onRemoveAll={() => {
                setRemovedSuggested((current) => [...current, ...keptSuggested.map((task) => normalizeTitle(task.title))]);
                setFocusCreate(true);
              }}
            />
            <LinksGroup
              rows={createdNotice ? [] : linkRows}
              onToggle={(link) => setUncheckedLinks((current) => (current.includes(linkId(link)) ? current.filter((id) => id !== linkId(link)) : [...current, linkId(link)]))}
              onOpen={onOpenExisting ?? onCreated}
            />
            {!createdNotice && outcome && <RelatedList related={outcome.related} onOpen={onOpenExisting ?? onCreated} />}
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
