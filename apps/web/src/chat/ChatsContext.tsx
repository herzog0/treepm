import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ApiClient, ConversationNode, Me, Person, Project, Team } from "../api/client.js";
import { useAutoRefresh } from "../map/useAutoRefresh.js";
import { safe } from "../panel/safe.js";

/** As pessoas, os projetos e os times que o seletor de menção e o aviso do assistente usam; carregados uma vez, quando o primeiro chat abre. */
export type Directory =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; me: Me; people: Person[]; projects: Project[]; teams: Team[] };

/**
 * O que a coluna da conversa mostra: uma conversa por id (principal, thread ou chat geral que já existe), a conversa da pessoa num
 * ticket (que pode ainda não existir: a leitura não cria nada) ou o chat geral que ainda não existe.
 */
export type ConversationRef = { kind: "conversation"; id: string } | { kind: "ticket"; ticketId: string } | { kind: "general" };

export const refKey = (ref: ConversationRef): string => (ref.kind === "conversation" ? `c:${ref.id}` : ref.kind === "ticket" ? `t:${ref.ticketId}` : "general");

/** A linha da barra abre este alvo: o que tem conversa abre por id; o que ainda não tem abre a leitura, sem criar nada. */
export function refOfNode(node: ConversationNode): ConversationRef {
  if (node.id !== null) return { kind: "conversation", id: node.id };
  return node.kind === "ticket" && node.ticket ? { kind: "ticket", ticketId: node.ticket.id } : { kind: "general" };
}

/** A linha está marcada quando é o alvo da coluna (a de um ticket serve também depois de a conversa nascer). */
export function nodeIsRef(node: ConversationNode, ref: ConversationRef): boolean {
  if (ref.kind === "conversation") return node.id === ref.id;
  if (ref.kind === "ticket") return node.kind === "ticket" && node.ticket?.id === ref.ticketId;
  return node.kind === "general";
}

const flatten = (nodes: readonly ConversationNode[]): ConversationNode[] => nodes.flatMap((node) => [node, ...flatten(node.children)]);

function withUnread(nodes: ConversationNode[], id: string, unread: number): ConversationNode[] {
  return nodes.map((node) => ({ ...node, unread: node.id === id ? unread : node.unread, children: withUnread(node.children, id, unread) }));
}

export interface ChatsApi {
  client: ApiClient;
  /** A coluna da conversa já foi aberta alguma vez (depois disso ela fica montada, só escondida, para a conversa em andamento não se perder). */
  opened: boolean;
  /** A coluna da conversa está à vista, ao lado do mapa. A lista "Conversas" fica sempre na barra lateral (ADR 0055). */
  open: boolean;
  /** O alvo da coluna; a linha dele na barra fica marcada enquanto `open`. */
  selection: ConversationRef | null;
  /** A árvore da barra: o chat geral, depois os tickets, cada um com as threads dentro. */
  tree: ConversationNode[] | null;
  listFailed: boolean;
  /** A própria pessoa, para a barra e os cartões dizerem "com Alice" sem nomeá-la. `undefined` até a resposta de `getMe`. */
  selfId: string | undefined;
  /** Quantas conversas têm mensagem não lida (não a soma das mensagens). */
  unreadChats: number;
  /** Muda a cada atualização da lista: a conversa aberta se atualiza junto, sem laço próprio. */
  version: number;
  directory: Directory;
  loadDirectory: () => void;
  select: (ref: ConversationRef) => void;
  /** "Abrir chat" da página do ticket: a leitura da conversa da pessoa nesse ticket. */
  openTicket: (ticketId: string) => void;
  close: () => void;
  refresh: () => Promise<void>;
  setConversationUnread: (conversationId: string, unread: number) => void;
  showTicket: (ticketId: string) => void;
}

const ChatsContext = createContext<ChatsApi | null>(null);

/** `null` fora de um `ChatsProvider`: as telas que mostram as conversas (a barra lateral, "Abrir chat" do ticket) simplesmente não aparecem. */
export function useChats(): ChatsApi | null {
  return useContext(ChatsContext);
}

interface ChatsProviderProps {
  client: ApiClient;
  /** "Ver no mapa" do cabeçalho do chat: abre a página do ticket e leva a câmera a ele. */
  onShowTicket: (ticketId: string) => void;
  children: ReactNode;
}

/**
 * O estado dos chats (ADR 0049, ADR 0055): a conversa aberta ao lado do mapa e a lista "Conversas" da barra lateral. Vive na memória da sessão (nada em
 * `localStorage`, nada na URL). A lista se atualiza ao abrir o painel e a cada passo do gatilho de 30 s do mapa, e alimenta o total de não lidas da barra lateral.
 */
export function ChatsProvider({ client, onShowTicket, children }: ChatsProviderProps) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const [selection, setSelection] = useState<ConversationRef | null>(null);
  const [tree, setTree] = useState<ConversationNode[] | null>(null);
  const [selfId, setSelfId] = useState<string | undefined>(undefined);
  const [listFailed, setListFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [directory, setDirectory] = useState<Directory>({ status: "idle" });
  const trigger = useRef<HTMLElement | null>(null);
  const requests = useRef(0);
  const directoryState = useRef<Directory["status"]>("idle");
  const showTicketRef = useRef(onShowTicket);
  showTicketRef.current = onShowTicket;

  const selfLoading = useRef(false);
  const selfKnown = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  /** Sem `selfId` o título da thread mostraria o próprio nome: se `getMe` falhou, a próxima atualização da lista tenta de novo. */
  const loadSelf = useCallback(async () => {
    if (selfKnown.current || selfLoading.current) return;
    selfLoading.current = true;
    const result = await safe(() => client.getMe());
    selfLoading.current = false;
    if (!mounted.current || !result.ok) return;
    selfKnown.current = true;
    setSelfId(result.data.person.id);
  }, [client]);

  const refresh = useCallback(async () => {
    const id = ++requests.current;
    const result = await safe(() => client.listConversationTree());
    // Uma resposta que chega depois de outra mais nova não vale.
    if (id !== requests.current) return;
    if (result.ok) {
      setTree(result.data.items);
      setListFailed(false);
      setVersion((current) => current + 1);
    } else {
      setListFailed(true);
    }
    void loadSelf();
  }, [client, loadSelf]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    void loadSelf();
  }, [loadSelf]);
  useAutoRefresh(async (isActive) => {
    if (isActive()) await refresh();
  });

  const loadDirectory = useCallback(() => {
    if (directoryState.current === "loading" || directoryState.current === "ready") return;
    directoryState.current = "loading";
    setDirectory({ status: "loading" });
    void Promise.all([safe(() => client.getMe()), safe(() => client.listPeople()), safe(() => client.listProjects()), safe(() => client.listTeams())]).then(([me, people, projects, teams]) => {
      if (me.ok && people.ok && projects.ok && teams.ok) {
        directoryState.current = "ready";
        setDirectory({ status: "ready", me: me.data, people: people.data, projects: projects.data, teams: teams.data });
      } else {
        directoryState.current = "error";
        setDirectory({ status: "error" });
      }
    });
  }, [client]);

  const treeRef = useRef(tree);
  treeRef.current = tree;
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const openPanel = useCallback((requested: ConversationRef) => {
    const active = document.activeElement;
    trigger.current = active instanceof HTMLElement && active !== document.body ? active : null;
    // A leitura do ticket (ou do chat geral) e a linha da conversa que ela criou são a mesma coisa: o painel não remonta, e o rascunho fica.
    const current = selectionRef.current;
    const same =
      current !== null && current.kind !== "conversation" && requested.kind === "conversation" &&
      flatten(treeRef.current ?? []).some((node) => node.id === requested.id && nodeIsRef(node, current));
    const next = same && current !== null ? current : requested;
    setSelection(next);
    setOpened(true);
    setOpen(true);
    void refresh();
  }, [refresh]);

  const close = useCallback(() => {
    setOpen(false);
    // O foco volta a quem abriu a conversa; se esse elemento já não existe, à linha dela na lista.
    queueMicrotask(() => {
      const target = trigger.current && trigger.current.isConnected ? trigger.current : document.querySelector<HTMLElement>("button.conv-row[aria-current]");
      target?.focus();
    });
  }, []);

  const unreadChats = useMemo(() => (tree === null ? 0 : flatten(tree).filter((node) => node.unread > 0).length), [tree]);
  const api = useMemo<ChatsApi>(
    () => ({
      client,
      opened,
      open,
      selection,
      tree,
      listFailed,
      selfId,
      unreadChats,
      version,
      directory,
      loadDirectory,
      select: openPanel,
      openTicket: (ticketId) => openPanel({ kind: "ticket", ticketId }),
      close,
      refresh,
      setConversationUnread: (id, unread) => setTree((current) => (current === null ? current : withUnread(current, id, unread))),
      showTicket: (id) => showTicketRef.current(id),
    }),
    [client, opened, open, selection, tree, listFailed, selfId, unreadChats, version, directory, loadDirectory, close, openPanel, refresh],
  );
  return <ChatsContext.Provider value={api}>{children}</ChatsContext.Provider>;
}
