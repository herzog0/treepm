import { forwardRef, useEffect, useRef, useState } from "react";
import type { TFunction } from "i18next";
import type { KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, IdeaStage, Person, TicketDetail, TicketStatus, TicketSummary, UpdateTicketBody } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useStatusText } from "../map/nodeContent.js";
import { StatusMark } from "../map/StatusMark.js";
import { isBlocked } from "../map/ticketState.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { OptionMenu } from "./menu.js";
import { useAction } from "../panel/useAction.js";
import { isOpenStatus, reopenedNoticeText, reopensOnReceiving } from "./reopen.js";
import { RichDescription } from "./description/RichDescription.js";
import type { DraftRequest } from "./description/WriterRequest.js";
import { descendantIds } from "./tree.js";
import { fold, searchTickets } from "../command/search.js";

const STATUSES: readonly TicketStatus[] = ["todo", "in_progress", "in_review", "done", "cancelled"];

type Action = ReturnType<typeof useAction>;
const ActionError = ({ action }: { action: Action }) => {
  const describeError = useDescribeApiError();
  return action.error ? <p role="alert" className="ticket-error">{describeError(action.error)}</p> : null;
};

/** Esc dentro da edição cancela só a edição: não chega à página, que fecharia. */
export function cancelOnEscape(onCancel: () => void) {
  return (event: KeyboardEvent) => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    event.preventDefault();
    onCancel();
  };
}

interface FieldBase {
  client: ApiClient;
  detail: TicketDetail;
  onSaved: () => void;
}

/** Edita o título com "Salvar" e "Cancelar"; só envia o que mudou. */
function useTextEdit(client: ApiClient, detail: TicketDetail, field: "title", onSaved: () => void) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const action = useAction();
  const startButton = useRef<HTMLButtonElement>(null);
  const wasEditing = useRef(false);
  // Ao sair da edição o foco volta ao botão que a abriu, para o teclado não se perder no corpo da página.
  useEffect(() => {
    if (wasEditing.current && !editing) startButton.current?.focus();
    wasEditing.current = editing;
  }, [editing]);
  const start = () => {
    action.clear();
    setDraft(detail[field]);
    setEditing(true);
  };
  const cancel = () => {
    action.clear();
    setEditing(false);
  };
  const value = draft.trim();
  const canSave = !action.busy && value !== detail[field] && value !== "";
  const save = async () => {
    if (!canSave) return;
    const body: UpdateTicketBody = { [field]: value };
    const result = await action.run(() => client.updateTicket(detail.id, body));
    if (!result.ok) return;
    setEditing(false);
    onSaved();
  };
  return { editing, draft, setDraft, action, start, startButton, cancel, canSave, save };
}

const EditActions = ({ canSave, onSave, onCancel }: { canSave: boolean; onSave: () => void; onCancel: () => void }) => {
  const { t } = useTranslation("ticket");
  return (
    <div className="ticket-actions">
      <button type="button" className="primary" disabled={!canSave} onClick={onSave}>{t("common.save")}</button>
      <button type="button" onClick={onCancel}>{t("common.cancel")}</button>
    </div>
  );
};

export const TitleField = forwardRef<HTMLHeadingElement, FieldBase & { canEdit: boolean }>(function TitleField({ client, detail, canEdit, onSaved }, ref) {
  const { t } = useTranslation("ticket");
  const edit = useTextEdit(client, detail, "title", onSaved);
  if (edit.editing) {
    return (
      <div className="ticket-edit" onKeyDown={cancelOnEscape(edit.cancel)}>
        <input aria-label={t("title.label")} autoFocus value={edit.draft} onChange={(event) => edit.setDraft(event.target.value)} />
        <EditActions canSave={edit.canSave} onSave={() => void edit.save()} onCancel={edit.cancel} />
        <ActionError action={edit.action} />
      </div>
    );
  }
  return (
    <div className="ticket-title-row">
      <h1 ref={ref} tabIndex={-1} className="ticket-title">{detail.title}</h1>
      {canEdit && <button ref={edit.startButton} type="button" className="text" onClick={edit.start}>{t("title.edit")}</button>}
    </div>
  );
});

interface DescriptionProps extends FieldBase {
  canEdit: boolean;
  /** O assistente está ligado neste ambiente: o menu "/" oferece "Pedir ao assistente para escrever". */
  assistant: boolean;
  /** Tickets do projeto: as chaves no texto viram menções e o "@" os lista. */
  tickets: readonly TicketSummary[];
  onOpenTicket: (id: string) => void;
}

type SaveState = "idle" | "saving" | "saved";

/**
 * Descrição do ticket (ADR 0036): o texto é o próprio campo. Clicar nele edita; sair do campo ou Ctrl+Enter salva; Esc desfaz.
 * A API só é chamada se o texto mudou, e quem só lê não edita.
 */
export function DescriptionField({ client, detail, canEdit, assistant, tickets, onOpenTicket, onSaved }: DescriptionProps) {
  const { t } = useTranslation("ticket");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(detail.description);
  const [state, setState] = useState<SaveState>("idle");
  // Depois de salvar, o texto novo vale até a recarga do ticket trazê-lo (o editor não volta ao texto antigo no intervalo).
  const [saved, setSaved] = useState<{ from: string; text: string } | null>(null);
  // Uma tarefa que não salvou: o editor recomeça do texto guardado.
  const [revision, setRevision] = useState(0);
  const action = useAction();
  const busy = useRef(false);
  const value = saved && saved.from === detail.description ? saved.text : detail.description;

  useEffect(() => {
    if (state !== "saved") return;
    const timer = setTimeout(() => setState("idle"), 2500);
    return () => clearTimeout(timer);
  }, [state]);

  const commit = async (text: string): Promise<boolean> => {
    if (text === value) return true;
    if (busy.current) return false;
    busy.current = true;
    setState("saving");
    const result = await action.run(() => client.updateTicket(detail.id, { description: text }));
    busy.current = false;
    if (!result.ok) {
      setState("idle");
      return false;
    }
    setSaved({ from: detail.description, text });
    setState("saved");
    onSaved();
    return true;
  };

  const startEditing = () => {
    action.clear();
    setDraft(value);
    setEditing(true);
  };
  const leave = async () => {
    if (await commit(draft)) setEditing(false);
  };
  const cancel = () => {
    action.clear();
    setDraft(value);
    setEditing(false);
  };
  // Pedir texto à IA não grava nada: o texto atual do editor vai junto (pode não estar salvo) e a resposta só entra por "Inserir".
  const askWriter: DraftRequest = async (request, description, signal) => {
    const result = await client.draftTicketDescription(detail.id, { request, description }, { signal });
    return result.ok ? { ok: true, text: result.data.text } : { ok: false, ...(result.error.code === "assistant_consent_required" ? { consentRequired: true } : {}) };
  };
  const toggleTask = async (text: string) => {
    if (!(await commit(text))) setRevision((current) => current + 1);
  };
  const openMention = async (id: string) => {
    if (editing && !(await commit(draft))) return;
    onOpenTicket(id);
  };

  const empty = value.trim() === "";
  return (
    <section className="ticket-section" aria-labelledby="ticket-description-heading">
      <div className="ticket-section-head">
        <h2 id="ticket-description-heading">{t("description.heading")}</h2>
        <span aria-live="polite" aria-atomic="true" className="description-head-state">{state === "saving" ? t("description.saving") : state === "saved" ? t("description.saved") : ""}</span>
      </div>
      {empty && !editing ? (
        canEdit ? (
          <button type="button" className="description-invite" onClick={startEditing}>{t("description.placeholder")}</button>
        ) : (
          <p className="ticket-muted">{t("description.empty")}</p>
        )
      ) : (
        <RichDescription
          key={revision}
          value={value}
          editing={editing}
          canEdit={canEdit}
          label={t("description.heading")}
          placeholder={t("description.placeholder")}
          mentions={{ projectId: detail.projectId, tickets, ownId: detail.id }}
          onChange={setDraft}
          {...(assistant && canEdit ? { onDraft: askWriter } : {})}
          autoFocus
          onRequestEdit={startEditing}
          onLeave={() => void leave()}
          onSubmit={() => void leave()}
          onCancel={cancel}
          onToggleTask={(text) => void toggleTask(text)}
          onOpenMention={(id) => void openMention(id)}
        />
      )}
      {canEdit && !editing && !empty && <p className="description-hint">{t("description.hint")}</p>}
      <ActionError action={action} />
    </section>
  );
}

/** Mensagem junto da situação quando a API recusa concluir com filho direto aberto (ADR 0034), no idioma ativo. */
// O singular não leva o número ("o item aberto"), então a regra de plural do catálogo (todas as formas com `{{count}}`) não o cobre: duas chaves.
export const openItemsText = (t: TFunction<"ticket">, count: number): string => (count === 1 ? t("status.openItem") : t("status.openItemsMany", { count }));

/** `openItems`: filhos diretos abertos, contados na lista de itens da própria página. */
export function StatusField({ client, detail, openItems, onSaved }: FieldBase & { openItems: number }) {
  const { t } = useTranslation("ticket");
  const statusText = useStatusText();
  const action = useAction();
  const change = async (status: TicketStatus) => {
    if (status === detail.status || action.busy) return;
    const result = await action.run(() => client.updateTicket(detail.id, { status }));
    if (result.ok) onSaved();
  };
  return (
    <>
      <OptionMenu
        label={t("status.group")}
        trigger={<StatusValue status={detail.status} blocked={isBlocked(detail)} />}
        options={STATUSES.map((status) => ({ value: status, label: statusText(status), mark: <StatusMark status={status} /> }))}
        value={detail.status}
        disabled={action.busy}
        onChoose={(status) => void change(status)}
      />
      {action.error?.code === "ticket_has_open_children" ? <p role="alert" className="ticket-error">{openItemsText(t, openItems)}</p> : <ActionError action={action} />}
    </>
  );
}

const PRIORITY_MIN = -999;
const PRIORITY_MAX = 999;

/** Lê o texto digitado como prioridade: só inteiro de -999 a 999; qualquer outra coisa é `null`. */
function parsePriority(text: string): number | null {
  if (!/^-?\d+$/.test(text.trim())) return null;
  const value = Number(text);
  return value >= PRIORITY_MIN && value <= PRIORITY_MAX ? value : null;
}

/** "vale 5, de ALFA-1": a prioridade herdada, quando a própria é 0 e um ancestral manda (ADR 0047). */
function InheritedPriority({ detail, onOpen }: { detail: TicketDetail; onOpen: (id: string) => void }) {
  const { t } = useTranslation("ticket");
  const effective = detail.effectivePriority;
  const own = detail.priority ?? 0;
  if (own !== 0 || !effective || effective.value === 0 || effective.from === null || effective.from.id === detail.id) return null;
  const from = effective.from;
  return (
    <span className="ticket-priority-inherited">
      {"· "}
      {t("priority.inherited", { value: effective.value })}{" "}
      <button type="button" className="text" onClick={() => onOpen(from.id)}>{from.key}</button>
    </span>
  );
}

/** Linha "Prioridade" (ADR 0047): o número, menos e mais (passo 1) e edição digitando; `Enter` grava e `Esc` desfaz. Quem só lê vê o número. */
export function PriorityField({ client, detail, canEdit, onOpen, onSaved }: FieldBase & { canEdit: boolean; onOpen: (id: string) => void }) {
  const { t } = useTranslation("ticket");
  const action = useAction();
  const value = detail.priority ?? 0;
  const [draft, setDraft] = useState(String(value));
  const [invalid, setInvalid] = useState(false);
  // O número da página é o que o servidor guardou: depois de gravar (ou de recarregar), o campo o acompanha.
  useEffect(() => {
    setDraft(String(value));
    setInvalid(false);
  }, [value]);

  const save = async (next: number) => {
    if (action.busy) return;
    if (next === value) {
      setDraft(String(value));
      return;
    }
    const result = await action.run(() => client.updateTicket(detail.id, { priority: next }));
    if (result.ok) onSaved();
    else setDraft(String(value));
  };
  const commit = () => {
    const parsed = parsePriority(draft);
    if (parsed === null) {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    void save(parsed);
  };
  const dirty = draft !== String(value) || invalid;
  const undo = () => {
    setDraft(String(value));
    setInvalid(false);
  };

  if (!canEdit) {
    return (
      <span className="ticket-value">
        {value}
        <InheritedPriority detail={detail} onOpen={onOpen} />
      </span>
    );
  }
  return (
    <>
      <span className="ticket-priority">
        <button type="button" className="ticket-priority-step" aria-label={t("priority.decrease")} disabled={action.busy || value <= PRIORITY_MIN} onClick={() => void save(value - 1)}>−</button>
        <input
          type="number"
          className="ticket-priority-input"
          aria-label={t("fields.priority")}
          aria-invalid={invalid || undefined}
          min={PRIORITY_MIN}
          max={PRIORITY_MAX}
          step={1}
          value={draft}
          disabled={action.busy}
          onChange={(event) => {
            setDraft(event.target.value);
            setInvalid(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commit();
            } else if (event.key === "Escape" && dirty) {
              event.stopPropagation();
              event.preventDefault();
              undo();
            }
          }}
        />
        <button type="button" className="ticket-priority-step" aria-label={t("priority.increase")} disabled={action.busy || value >= PRIORITY_MAX} onClick={() => void save(value + 1)}>+</button>
        <InheritedPriority detail={detail} onOpen={onOpen} />
      </span>
      {invalid && <p role="alert" className="ticket-error">{t("priority.invalid")}</p>}
      <ActionError action={action} />
    </>
  );
}

const IDEA_STAGES: readonly Exclude<IdeaStage, "discarded">[] = ["new", "refining", "ready"];

/** Marcador e nome do estágio de uma ideia (ADR 0042): o valor da linha "Ideia", com ou sem menu. */
export function IdeaStageValue({ stage }: { stage: IdeaStage }) {
  const { t } = useTranslation("map");
  return (
    <>
      <StatusMark idea={{ discarded: stage === "discarded" }} />
      {t(`idea.stage.${stage}`)}
    </>
  );
}

/**
 * Linha "Ideia" da raiz de uma ideia (ADR 0042), no lugar da situação. Quem edita muda o estágio num menu; quem pode fazer a
 * triagem (`canTriage`) também aceita e descarta, cada um com a confirmação que diz o que acontece com a subárvore. A ideia
 * descartada mostra "Descartada" e "Reabrir" (volta para "Em refinamento"). Quem só lê vê o estágio.
 */
export function IdeaField({ client, detail, stage, canEdit, canTriage, onSaved }: FieldBase & { stage: IdeaStage; canEdit: boolean; canTriage: boolean }) {
  const { t } = useTranslation("ticket");
  const { t: tMap } = useTranslation("map");
  const action = useAction();
  const run = async (call: () => ReturnType<typeof client.acceptIdea>) => {
    if (action.busy) return;
    const result = await action.run(call);
    if (result.ok) onSaved();
  };
  if (!canEdit) {
    return (
      <span className="ticket-value">
        <IdeaStageValue stage={stage} />
      </span>
    );
  }
  const stageValue = <IdeaStageValue stage={stage} />;
  return (
    <>
      <span className="ticket-idea-row">
        {stage === "discarded" ? (
          <>
            <span className="ticket-value">{stageValue}</span>
            <button type="button" className="text" disabled={action.busy} onClick={() => void run(() => client.putIdeaStage(detail.id, { stage: "refining" }))}>{t("idea.reopen")}</button>
          </>
        ) : (
          <>
            <OptionMenu
              label={t("idea.stageMenu")}
              trigger={stageValue}
              options={IDEA_STAGES.map((value) => ({ value, label: tMap(`idea.stage.${value}`), mark: <StatusMark idea={{ discarded: false }} /> }))}
              value={stage as (typeof IDEA_STAGES)[number]}
              disabled={action.busy}
              onChoose={(next) => void run(() => client.putIdeaStage(detail.id, { stage: next }))}
            />
            {canTriage && (
              <>
                <ConfirmAction label={t("idea.accept")} tone="neutral" message={t("idea.acceptMessage")} disabled={action.busy} onConfirm={() => void run(() => client.acceptIdea(detail.id))} />
                <ConfirmAction label={t("idea.discard")} message={t("idea.discardMessage")} disabled={action.busy} onConfirm={() => void run(() => client.discardIdea(detail.id))} />
              </>
            )}
          </>
        )}
      </span>
      <ActionError action={action} />
    </>
  );
}

/** Linha "Situação" de um ticket dentro de uma ideia (ADR 0042): "Parte da ideia <chave>", com o link para a raiz; sem menu. */
export function InsideIdeaValue({ rootId, rootKey, discarded, onOpen }: { rootId: string; rootKey: string; discarded: boolean; onOpen: (id: string) => void }) {
  const { t } = useTranslation("ticket");
  return (
    <span className="ticket-value">
      <StatusMark idea={{ discarded }} />
      <span>
        {t("idea.partOf")}{" "}
        <button type="button" className="ticket-activity-ref" onClick={() => onOpen(rootId)}>{rootKey}</button>
      </span>
    </span>
  );
}

/** Marcador e texto da situação: o valor da linha, com ou sem menu. */
export function StatusValue({ status, blocked = false }: { status: TicketStatus; blocked?: boolean }) {
  const statusText = useStatusText();
  const { t: tMap } = useTranslation("map");
  return (
    <>
      <StatusMark status={status} blocked={blocked} />
      {statusText(status)}
      {blocked && <span className="ticket-blocked-tag">{tMap("status.blocked")}</span>}
    </>
  );
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("");

export function PeopleField({ client, detail, people, canEdit, onSaved }: FieldBase & { people: readonly Person[]; canEdit: boolean }) {
  const { t } = useTranslation("ticket");
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const assigned = new Set(detail.assigneeIds);
  const candidates = people.filter((person) => person.active && !assigned.has(person.id));
  const nameOf = (id: string) => people.find((person) => person.id === id)?.displayName ?? t("people.removed");

  const add = async (personId: string) => {
    if (personId === "") return;
    const result = await action.run(() => client.putTicketAssignee(detail.id, personId));
    if (!result.ok) return;
    setAdding(false);
    onSaved();
  };
  const remove = async (personId: string) => {
    const result = await action.run(() => client.removeTicketAssignee(detail.id, personId));
    if (result.ok) onSaved();
  };

  return (
    <>
      <div className="ticket-people">
        {detail.assigneeIds.length === 0 && !canEdit && <span className="ticket-muted">{t("people.nobody")}</span>}
        {detail.assigneeIds.map((id) => (
          <span key={id} className="ticket-person">
            <span aria-hidden="true" className="ticket-avatar">{initials(nameOf(id))}</span>
            {nameOf(id)}
            {canEdit && (
              <button type="button" className="ticket-person-remove" aria-label={t("people.remove", { name: nameOf(id) })} disabled={action.busy} onClick={() => void remove(id)}>×</button>
            )}
          </span>
        ))}
        {canEdit && !adding && <button type="button" className="ticket-dashed" onClick={() => setAdding(true)}>{t("people.add")}</button>}
        {canEdit && adding && (
          <select aria-label={t("people.addLabel")} autoFocus value="" disabled={action.busy} onChange={(event) => void add(event.target.value)}>
            <option value="">{t("people.choose")}</option>
            {candidates.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
          </select>
        )}
      </div>
      <ActionError action={action} />
    </>
  );
}

interface ParentProps extends FieldBase {
  parent: TicketSummary | null;
  tickets: readonly TicketSummary[];
  canEdit: boolean;
  onOpen: (id: string) => void;
}

const TicketLabel = ({ ticket }: { ticket: TicketSummary }): ReactNode => (
  <>
    <span className="ticket-key">{ticket.key}</span>
    <span className="ticket-child-title">{ticket.title}</span>
  </>
);

export function ParentField({ client, detail, parent, tickets, canEdit, onOpen, onSaved }: ParentProps) {
  const { t } = useTranslation("ticket");
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const [reopened, setReopened] = useState<string | null>(null);
  const action = useAction();
  const blocked = descendantIds(tickets, detail.id);
  const needle = filter.trim().toLowerCase();
  const rootText = t("parent.root");
  const matches = (text: string) => needle === "" || text.toLowerCase().includes(needle);
  // Qualquer ticket do projeto recebe itens (ADR 0034): só o próprio nó e seus descendentes ficam fora.
  const candidates = tickets.filter((entry) => entry.id !== detail.id && !blocked.has(entry.id) && matches(`${entry.key} ${entry.title}`));

  const choose = async (parentId: string | null) => {
    const result = await action.run(() => client.updateTicket(detail.id, { parentId }));
    if (!result.ok) return;
    // A escolha vale no clique, sem confirmação: o aviso diz o que a API fez (ADR 0034).
    const target = parentId === null ? null : tickets.find((entry) => entry.id === parentId);
    setReopened(target && reopensOnReceiving(target) && isOpenStatus(detail.status) ? target.key : null);
    setPicking(false);
    setFilter("");
    onSaved();
  };

  return (
    <>
      <div className="ticket-parent">
        {parent ? (
          <button type="button" className="ticket-chip ticket-chip-button" onClick={() => onOpen(parent.id)}><TicketLabel ticket={parent} /></button>
        ) : (
          <span>{rootText}</span>
        )}
        {canEdit && (
          <button type="button" className="text" aria-expanded={picking} onClick={() => { setReopened(null); setPicking((open) => !open); }}>{t("parent.change")}</button>
        )}
      </div>
      {reopened !== null && <p className="ticket-notice" role="status">{reopenedNoticeText(t, reopened)}</p>}
      {picking && (
        <div className="ticket-picker" role="group" aria-label={t("parent.pickerLabel")}>
          <input aria-label={t("parent.filter")} autoFocus value={filter} onChange={(event) => setFilter(event.target.value)} />
          <div className="ticket-picker-list">
            {matches(rootText) && <button type="button" disabled={action.busy} onClick={() => void choose(null)}>{rootText}</button>}
            {candidates.map((entry) => (
              <button key={entry.id} type="button" disabled={action.busy} onClick={() => void choose(entry.id)}><TicketLabel ticket={entry} /></button>
            ))}
          </div>
        </div>
      )}
      <ActionError action={action} />
    </>
  );
}

interface DependsOnProps extends FieldBase {
  tickets: readonly TicketSummary[];
  canEdit: boolean;
  onOpen: (id: string) => void;
}

/**
 * "Depende de" (ADR 0037): os tickets de que este precisa, com remover e "Adicionar". O seletor só oferece tickets do mesmo
 * projeto, sem o próprio e sem os que já estão na lista. Esc fecha só o seletor; as setas percorrem busca e lista.
 */
export function DependsOnField({ client, detail, tickets, canEdit, onOpen, onSaved }: DependsOnProps) {
  const { t } = useTranslation("ticket");
  const [picking, setPicking] = useState(false);
  const [filter, setFilter] = useState("");
  const [tried, setTried] = useState("");
  const action = useAction();
  const describeError = useDescribeApiError();
  const addButton = useRef<HTMLButtonElement>(null);
  const picker = useRef<HTMLDivElement>(null);
  const listed = new Set(detail.dependsOn.map((entry) => entry.id));
  const pool = tickets.filter((entry) => entry.projectId === detail.projectId && entry.id !== detail.id && !listed.has(entry.id));
  const candidates = fold(filter).trim() === "" ? pool : searchTickets(filter, { [detail.projectId]: pool });

  const close = () => {
    setPicking(false);
    setFilter("");
    addButton.current?.focus();
  };
  const choose = async (entry: TicketSummary) => {
    setTried(entry.key);
    const result = await action.run(() => client.addTicketDependency(detail.id, entry.id));
    if (!result.ok) return;
    setPicking(false);
    setFilter("");
    onSaved();
  };
  const remove = async (id: string) => {
    const result = await action.run(() => client.removeTicketDependency(detail.id, id));
    if (result.ok) onSaved();
  };
  const onPickerKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      event.preventDefault();
      close();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const stops = [...(picker.current?.querySelectorAll<HTMLElement>("input, button") ?? [])];
    const at = stops.indexOf(document.activeElement as HTMLElement);
    event.preventDefault();
    stops[Math.min(Math.max(at + (event.key === "ArrowDown" ? 1 : -1), 0), stops.length - 1)]?.focus();
  };

  return (
    <>
      <div className="ticket-deps">
        {detail.dependsOn.map((entry) => (
          <span key={entry.id} className="ticket-dep">
            <button type="button" className="ticket-chip ticket-chip-button" onClick={() => onOpen(entry.id)}>
              <StatusMark status={entry.status} />
              <span className="ticket-key">{entry.key}</span>
              <span className="ticket-child-title">{entry.title}</span>
            </button>
            {canEdit && (
              <button type="button" className="ticket-person-remove" aria-label={t("dependsOn.remove", { key: entry.key })} disabled={action.busy} onClick={() => void remove(entry.id)}>×</button>
            )}
          </span>
        ))}
        {canEdit && (
          <button
            ref={addButton}
            type="button"
            className="ticket-dashed"
            aria-label={t("dependsOn.addLabel")}
            aria-expanded={picking}
            onClick={() => { action.clear(); setPicking((open) => !open); }}
          >
            {t("dependsOn.add")}
          </button>
        )}
      </div>
      {canEdit && picking && (
        <div ref={picker} className="ticket-picker" role="group" aria-label={t("dependsOn.pickerLabel")} onKeyDown={onPickerKeyDown}>
          <input aria-label={t("dependsOn.filter")} autoFocus value={filter} onChange={(event) => setFilter(event.target.value)} />
          <div className="ticket-picker-list">
            {candidates.map((entry) => (
              <button key={entry.id} type="button" disabled={action.busy} onClick={() => void choose(entry)}><TicketLabel ticket={entry} /></button>
            ))}
            {candidates.length === 0 && <p className="ticket-muted">{t("dependsOn.none")}</p>}
          </div>
        </div>
      )}
      {action.error?.code === "dependency_cycle" ? <p role="alert" className="ticket-error">{t("dependsOn.cycle", { key: tried })}</p> : action.error && <p role="alert" className="ticket-error">{describeError(action.error)}</p>}
    </>
  );
}
