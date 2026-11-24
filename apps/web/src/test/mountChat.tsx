import { useState } from "react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, ApiResult, ConversationDetail, Project, TicketSummary } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { PickBar } from "../chat/CreationThread.js";
import { Chat } from "../assistant/CreationChat.js";
import type { ConversationProps } from "../assistant/CreationChat.js";
import type { MapDraft } from "../map/items.js";
import type { MapPicker } from "../assistant/types.js";
import { safe } from "../panel/safe.js";

/**
 * Ajudante único de montagem dos testes do miolo da criação (ADR 0056): hospeda o `Chat` como a thread de criação o faz
 * (a região, o espaço do chip de escopo e o das ações, a escolha no mapa) e, com `resume`, entrega a ele a conversa aberta mais
 * recente do projeto, que é o que a thread faz ao ler a conversa de novo ticket por id.
 */
export interface MountProps {
  client: ApiClient;
  projects: readonly Project[];
  initialProjectId: string;
  initialScopeId?: string | null;
  tickets: Readonly<Record<string, readonly TicketSummary[]>>;
  /** Entrega ao miolo a conversa aberta mais recente do projeto (`true`) ou começa vazio (`false`). */
  resume: boolean;
  onCreated: (ticketId: string) => void;
  onOpenExisting?: (ticketId: string) => void;
  onManualCreate: ConversationProps["onManualCreate"];
  onDraftChange: (draft: MapDraft | null) => void;
  onChanged: () => void;
  registerPicker: (picker: MapPicker | null) => void;
  /** Padrão: há mapa (o caso da tela de mapa). */
  canPickOnMap?: boolean;
  onRemoved?: () => void;
  onActivity?: () => void;
}

export function ChatHarness(props: MountProps) {
  const { t } = useTranslation("assistant");
  const [choosing, setChoosing] = useState(false);
  const [pickNotice, setPickNotice] = useState("");
  const [chipSlot, setChipSlot] = useState<HTMLElement | null>(null);
  const [actionsSlot, setActionsSlot] = useState<HTMLElement | null>(null);
  const [scopeId, setScopeId] = useState<string | null>(props.initialScopeId ?? null);
  const project = props.projects.find((entry) => entry.id === props.initialProjectId)!;
  const scopeTicket = (props.tickets[project.id] ?? []).find((entry) => entry.id === scopeId);
  const scope = scopeTicket ? { id: scopeTicket.id, key: scopeTicket.key, title: scopeTicket.title } : null;
  return (
    <div className="creation-thread">
      <span ref={setChipSlot} className="assistant-chip-slot" />
      <div ref={setActionsSlot} className="assistant-header-actions" />
      <section className="assistant-body" aria-label={t("panel.label")} hidden={choosing}>
        <Initial {...props}>
          {(initial) => (
          <Chat
            client={props.client}
            projects={props.projects}
            project={project}
            tickets={props.tickets}
            onCreated={props.onCreated}
            onOpenExisting={props.onOpenExisting}
            onManualCreate={props.onManualCreate}
            onDraftChange={props.onDraftChange}
            onChanged={props.onChanged}
            registerPicker={props.registerPicker}
            canPickOnMap={props.canPickOnMap ?? true}
            choosing={choosing}
            setChoosing={setChoosing}
            pickNotice={pickNotice}
            setPickNotice={setPickNotice}
            scope={scope}
            onRemoveScope={() => setScopeId(null)}
            chipSlot={chipSlot}
            actionsSlot={actionsSlot}
            onRemoved={props.onRemoved ?? (() => undefined)}
            onActivity={props.onActivity}
            initial={initial}
          />
          )}
        </Initial>
      </section>
      {choosing && <PickBar notice={pickNotice} onCancel={() => setChoosing(false)} />}
    </div>
  );
}

/** Com `resume`, a conversa aberta mais recente do projeto chega ao miolo depois de carregada; sem ele, o miolo monta na hora, vazio. */
function Initial({ client, initialProjectId, resume, children }: MountProps & { children: (initial: ConversationDetail | null) => ReactNode }) {
  if (!resume) return <>{children(null)}</>;
  return <Resumed client={client} projectId={initialProjectId}>{children}</Resumed>;
}

function Resumed({ client, projectId, children }: { client: ApiClient; projectId: string; children: (initial: ConversationDetail | null) => ReactNode }) {
  const loaded = useApiResource(() =>
    safe(async (): Promise<ApiResult<ConversationDetail | null>> => {
      const list = await client.listConversations(projectId);
      if (!list.ok) return list;
      const latest = list.data.filter((entry) => entry.status === "open").sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
      return latest ? client.getConversation(latest.id) : { ok: true, data: null };
    }),
  );
  if (loaded.state.status !== "ready") return null;
  return <>{children(loaded.state.data)}</>;
}
