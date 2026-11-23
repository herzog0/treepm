import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import type { ApiClient, ChatListItem, Me, Person, Project, Team } from "../api/client.js";
import { useAutoRefresh } from "../map/useAutoRefresh.js";
import { safe } from "../panel/safe.js";

/** As pessoas, os projetos e os times que o seletor de menção e o aviso do assistente usam; carregados uma vez, quando o primeiro chat abre. */
export type Directory =
  | { status: "idle" | "loading" | "error" }
  | { status: "ready"; me: Me; people: Person[]; projects: Project[]; teams: Team[] };

export interface ChatsApi {
  client: ApiClient;
  /** O painel já foi aberto alguma vez (depois disso ele fica montado, só escondido, para a conversa em andamento não se perder). */
  opened: boolean;
  open: boolean;
  /** O chat aberto no painel; `null` mostra a lista "Meus chats". */
  ticketId: string | null;
  chats: ChatListItem[] | null;
  listFailed: boolean;
  /** Quantos chats têm mensagem não lida (não a soma das mensagens). */
  unreadChats: number;
  /** Muda a cada atualização da lista: o chat aberto se atualiza junto, sem laço próprio. */
  version: number;
  directory: Directory;
  loadDirectory: () => void;
  toggle: () => void;
  openList: () => void;
  openChat: (ticketId: string) => void;
  close: () => void;
  refresh: () => Promise<void>;
  setChatUnread: (ticketId: string, unread: number) => void;
  showTicket: (ticketId: string) => void;
  registerButton: (element: HTMLElement | null) => void;
}

const ChatsContext = createContext<ChatsApi | null>(null);

/** `null` fora de um `ChatsProvider`: as telas que mostram o chat (botão do cabeçalho, "Abrir chat" do ticket) simplesmente não aparecem. */
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
 * O estado do painel de chats (ADR 0049): aberto ou não, o chat aberto e a lista "Meus chats". Vive na memória da sessão (nada em
 * `localStorage`, nada na URL). A lista se atualiza ao abrir o painel e a cada passo do gatilho de 30 s do mapa, e alimenta o número do botão.
 */
export function ChatsProvider({ client, onShowTicket, children }: ChatsProviderProps) {
  const [open, setOpen] = useState(false);
  const [opened, setOpened] = useState(false);
  const [ticketId, setTicketId] = useState<string | null>(null);
  const [chats, setChats] = useState<ChatListItem[] | null>(null);
  const [listFailed, setListFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const [directory, setDirectory] = useState<Directory>({ status: "idle" });
  const trigger = useRef<HTMLElement | null>(null);
  const button = useRef<HTMLElement | null>(null);
  const requests = useRef(0);
  const directoryState = useRef<Directory["status"]>("idle");
  const showTicketRef = useRef(onShowTicket);
  showTicketRef.current = onShowTicket;

  const refresh = useCallback(async () => {
    const id = ++requests.current;
    const result = await safe(() => client.listChats());
    // Uma resposta que chega depois de outra mais nova não vale.
    if (id !== requests.current) return;
    if (result.ok) {
      setChats(result.data.items);
      setListFailed(false);
      setVersion((current) => current + 1);
    } else {
      setListFailed(true);
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh]);
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

  const openPanel = useCallback((next: string | null | undefined) => {
    const active = document.activeElement;
    trigger.current = active instanceof HTMLElement && active !== document.body ? active : null;
    if (next !== undefined) setTicketId(next);
    setOpened(true);
    setOpen(true);
    void refresh();
  }, [refresh]);

  const close = useCallback(() => {
    setOpen(false);
    // O foco volta a quem abriu o painel; se esse elemento já não existe, ao botão do cabeçalho.
    queueMicrotask(() => {
      const target = trigger.current && trigger.current.isConnected ? trigger.current : button.current;
      target?.focus();
    });
  }, []);

  const api = useMemo<ChatsApi>(
    () => ({
      client,
      opened,
      open,
      ticketId,
      chats,
      listFailed,
      unreadChats: chats === null ? 0 : chats.filter((chat) => chat.unread > 0).length,
      version,
      directory,
      loadDirectory,
      toggle: () => (open ? close() : openPanel(undefined)),
      openList: () => {
        setTicketId(null);
        if (!open) openPanel(null);
      },
      openChat: (id) => openPanel(id),
      close,
      refresh,
      setChatUnread: (id, unread) => setChats((current) => (current === null ? current : current.map((chat) => (chat.ticketId === id ? { ...chat, unread } : chat)))),
      showTicket: (id) => showTicketRef.current(id),
      registerButton: (element) => {
        button.current = element;
      },
    }),
    [client, opened, open, ticketId, chats, listFailed, version, directory, loadDirectory, close, openPanel, refresh],
  );
  return <ChatsContext.Provider value={api}>{children}</ChatsContext.Provider>;
}
