import { forwardRef, useEffect, useRef, useState } from "react";
import type { KeyboardEvent, ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, DependencyNeed, IdeaStage, Person, TicketDetail, TicketStatus, TicketSummary, UpdateTicketBody } from "../api/client.js";
import { useRecentPlaces } from "../assistant/RecentPlacesContext.js";
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
import { TestBadge, useNameWithBadge } from "../people/TestBadge.js";
import { fold, searchTickets } from "../command/search.js";
import { DUE_DATE_MAX, DUE_DATE_MIN, daysOverdue, isOverdue, isStatusDerived, isValidDueDate } from "@treepm/domain";
import { formatDateTime, formatDueDate } from "../i18n/format.js";
import type { Language } from "../i18n/languages.js";
import { useLocalToday } from "./clock.js";

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

/**
 * A situação na página do ticket. Ticket com filhos (sem contar ideias) tem a situação calculada a partir deles (ADR 0068): mostra a
 * situação e a linha que diz de onde ela vem, sem menu. Os outros escolhem a situação no menu.
 */
export function StatusField({ client, detail, onSaved }: FieldBase) {
  const { t } = useTranslation("ticket");
  const statusText = useStatusText();
  const action = useAction();
  if (isStatusDerived(detail.progress)) return <DerivedStatus detail={detail} />;
  const change = async (status: TicketStatus) => {
    if (status === detail.status || action.busy) return;
    const result = await action.run(() => client.updateTicket(detail.id, { status }));
    if (result.ok) onSaved();
  };
  return (
    <>
      <OptionMenu
        label={t("status.group")}
        trigger={<StatusValue status={detail.status} blocked={isBlocked(detail)} place={detail.place ?? null} placeTag={false} />}
        options={STATUSES.map((status) => ({ value: status, label: statusText(status), mark: <StatusMark status={status} /> }))}
        value={detail.status}
        disabled={action.busy}
        onChoose={(status) => void change(status)}
      />
      <PlaceTag place={shownPlace(detail.status, isBlocked(detail), detail.place ?? null)} />
      <ActionError action={action} />
    </>
  );
}

/** A situação calculada a partir dos filhos (ADR 0068): o valor e a linha que diz de onde vem, sem menu, para quem edita e quem só lê. */
export function DerivedStatus({ detail }: { detail: TicketDetail }) {
  const { t } = useTranslation("ticket");
  return (
    <>
      <span className="ticket-value">
        <StatusValue status={detail.status} blocked={isBlocked(detail)} place={detail.place ?? null} />
      </span>
      <p className="ticket-muted">{t("status.derived")}</p>
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

/** Teclas que mudam um segmento do seletor de data; as setas laterais, Tab, Enter e Esc só andam ou confirmam. */
const DUE_DATE_EDIT_KEY = /^(?:[0-9]|Backspace|Delete|ArrowUp|ArrowDown|PageUp|PageDown)$/;

/**
 * Linha "Prazo" (ADR 0064): a data no idioma da interface; atrasada (pelo dia do navegador), em destaque com "atrasado há
 * N dias". Fora de edição o texto fica por cima do seletor de data do navegador (transparente); com o foco no campo ou no "×",
 * os segmentos do seletor aparecem no lugar do texto, na mesma caixa: nada na linha se move ao focar ou desfocar.
 *
 * Só grava o que a pessoa mudou: uma tecla num segmento, ou a confirmação no calendário do navegador (o `change` nativo com o
 * campo focado e sem tecla; as setas do calendário emitem só `input`, e fechar o calendário clicando fora emite `change` depois
 * do `blur`). Sem mudança da pessoa, sair não grava, e o campo acompanha o valor do servidor. Com mudança, grava uma vez ao
 * confirmar (Enter ou saída da linha) se o rascunho é uma data válida e diferente; fora da faixa avisa e volta ao valor de antes;
 * incompleto volta ao valor de antes. Esc descarta o rascunho. O "×" descarta o rascunho e só tira o prazo: ir do campo ao "×"
 * não grava, e o clique no "×" não tira o foco do campo.
 */
export function DueDateField({ client, detail, canEdit, onSaved }: FieldBase & { canEdit: boolean }) {
  const { t, i18n } = useTranslation("ticket");
  const action = useAction();
  const today = useLocalToday();
  const value = detail.dueDate ?? null;
  const [draft, setDraft] = useState(value ?? "");
  const [invalid, setInvalid] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const clearButton = useRef<HTMLButtonElement>(null);
  // A pessoa mudou o campo desde a última confirmação (o rascunho pode estar só nos segmentos: data incompleta vale "").
  const dirty = useRef(false);
  // Uma tecla neste instante: o `change` que vier junto é digitação, não a escolha no calendário.
  const keyed = useRef(false);
  // Sem mudança da pessoa, o campo mostra (e parte d)o valor do servidor, mesmo com o foco.
  useEffect(() => {
    if (!dirty.current) setDraft(value ?? "");
    setInvalid(false);
  }, [value]);
  const overdueInput = { dueDate: value, category: detail.status, today, idea: detail.idea != null };
  const overdue = isOverdue(overdueInput);
  const text = value === null ? null : formatDueDate(i18n.language as Language, value);

  const save = async (next: string | null) => {
    if (action.busy || next === value) return false;
    const result = await action.run(() => client.updateTicket(detail.id, { dueDate: next }));
    if (result.ok) onSaved();
    else setDraft(value ?? "");
    return result.ok;
  };
  /** Volta ao valor do servidor, inclusive os segmentos de uma data incompleta, que o valor do campo ("") não enxerga. */
  const reset = (element: HTMLInputElement) => {
    dirty.current = false;
    const current = value ?? "";
    element.value = current;
    setDraft(current);
  };
  const commit = (element: HTMLInputElement) => {
    const next = element.value;
    if (!dirty.current || next === "") return reset(element);
    if (!isValidDueDate(next)) {
      setInvalid(true);
      return reset(element);
    }
    dirty.current = false;
    void save(next);
  };
  const clear = () => {
    if (action.busy) return;
    if (input.current) reset(input.current);
    setInvalid(false);
    const fromButton = document.activeElement === clearButton.current;
    void save(null).then((ok) => {
      // O "×" some com o prazo: quem chegou nele pelo teclado continua na linha, no campo.
      if (ok && fromButton && document.activeElement === clearButton.current) input.current?.focus();
    });
  };
  // O `change` nativo sem tecla no campo: a confirmação no calendário do navegador, se o campo ainda tem o foco.
  const confirmPicked = useRef<(element: HTMLInputElement) => void>(() => undefined);
  confirmPicked.current = (element) => {
    if (keyed.current) return;
    if (document.activeElement !== element) return reset(element);
    dirty.current = true;
    commit(element);
  };
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    const listener = () => confirmPicked.current(element);
    element.addEventListener("change", listener);
    return () => element.removeEventListener("change", listener);
  }, [canEdit]);
  const note = overdue ? <span className="ticket-due-note">{t("dueDate.overdue", { count: daysOverdue(overdueInput) })}</span> : null;

  if (!canEdit) {
    return (
      <span className="ticket-value">
        {value === null ? <span className="ticket-due-empty">{t("dueDate.none")}</span> : <time dateTime={value} className={overdue ? "ticket-due-text is-overdue" : "ticket-due-text"}>{text}</time>}
        {note}
      </span>
    );
  }
  return (
    <>
      <span
        className="ticket-due"
        onBlur={(event) => {
          // Ir do campo ao "×" (ou voltar) fica dentro da linha: só a saída da linha confirma.
          if (input.current && !event.currentTarget.contains(event.relatedTarget as Node | null)) commit(input.current);
        }}
      >
        <span className={overdue ? "ticket-due-picker is-overdue" : "ticket-due-picker"}>
          <span className={value === null ? "ticket-due-text ticket-due-empty" : "ticket-due-text"} aria-hidden="true">{text ?? t("dueDate.set")}</span>
          <input
            ref={input}
            type="date"
            className="ticket-due-input"
            aria-label={t("fields.dueDate")}
            aria-invalid={invalid || undefined}
            min={DUE_DATE_MIN}
            max={DUE_DATE_MAX}
            value={draft}
            readOnly={action.busy}
            onClick={(event) => {
              // O texto por cima é o que se vê; o clique abre o calendário do navegador onde houver.
              try {
                event.currentTarget.showPicker();
              } catch {
                // Sem calendário (ou sem gesto do usuário): o campo continua aceitando o teclado.
              }
            }}
            onKeyDown={(event) => {
              const element = event.currentTarget;
              if (event.key === "Enter") {
                event.preventDefault();
                commit(element);
              } else if (event.key === "Escape") {
                if (dirty.current || element.validity.badInput) {
                  event.stopPropagation();
                  event.preventDefault();
                  reset(element);
                }
              } else if (event.key !== "Tab") {
                keyed.current = true;
                setTimeout(() => {
                  keyed.current = false;
                }, 0);
                // Com Alt, Ctrl ou Meta a tecla é atalho (Alt+↓ abre o calendário), não edição de segmento.
                if (DUE_DATE_EDIT_KEY.test(event.key) && !event.altKey && !event.ctrlKey && !event.metaKey && !action.busy) {
                  dirty.current = true;
                  setInvalid(false);
                }
              }
            }}
            onChange={(event) => {
              // Só o rascunho: digitação ou o calendário ainda aberto. Quem grava é a confirmação.
              setDraft(event.target.value);
            }}
          />
        </span>
        {value !== null && (
          <button
            ref={clearButton}
            type="button"
            className="ticket-priority-step"
            aria-label={t("dueDate.clear")}
            aria-disabled={action.busy || undefined}
            // O clique não tira o foco do campo: a saída não confirma o rascunho que o "×" descarta, e o botão não anda.
            onMouseDown={(event) => event.preventDefault()}
            onClick={clear}
          >
            ×
          </button>
        )}
        {note}
      </span>
      {invalid && <p role="alert" className="ticket-error">{t("dueDate.invalid")}</p>}
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

/**
 * Marcador e texto da situação: o valor da linha, com ou sem menu. Num "a fazer" com lugar na fila (ADR 0069), o marcador leva a cor
 * do lugar e uma etiqueta o escreve (`PlaceTag`); o bloqueado vence. `placeTag={false}` deixa a etiqueta de fora: o gatilho do menu a
 * põe ao lado do botão, para o nome do botão continuar sendo a situação.
 */
export function StatusValue({ status, blocked = false, place = null, placeTag = true }: { status: TicketStatus; blocked?: boolean; place?: TicketDetail["place"]; placeTag?: boolean }) {
  const statusText = useStatusText();
  const { t: tMap } = useTranslation("map");
  const shown = shownPlace(status, blocked, place);
  return (
    <>
      <StatusMark status={status} blocked={blocked} place={shown} />
      {statusText(status)}
      {blocked && <span className="ticket-blocked-tag">{tMap("status.blocked")}</span>}
      {placeTag && <PlaceTag place={shown} />}
    </>
  );
}

/** O lugar que a página mostra: só num "a fazer" sem impedimento (ADR 0069). */
const shownPlace = (status: TicketStatus, blocked: boolean, place: TicketDetail["place"]) => (!blocked && status === "todo" ? (place ?? null) : null);

/** A etiqueta escrita do lugar na fila, na cor dele (ADR 0069); nada sem lugar. */
function PlaceTag({ place }: { place: TicketDetail["place"] }) {
  const { t: tMap } = useTranslation("map");
  return place == null ? null : <span className="ticket-place-tag" data-place={place}>{tMap(`status.${place}`)}</span>;
}

export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part[0]!.toUpperCase()).join("");

export function PeopleField({ client, detail, people, canEdit, onSaved }: FieldBase & { people: readonly Person[]; canEdit: boolean }) {
  const { t } = useTranslation("ticket");
  const [adding, setAdding] = useState(false);
  const action = useAction();
  const assigned = new Set(detail.assigneeIds);
  const candidates = people.filter((person) => person.active && !assigned.has(person.id));
  const nameOf = (id: string) => people.find((person) => person.id === id)?.displayName ?? t("people.removed");
  const nameWithBadge = useNameWithBadge();

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
            <TestBadge person={people.find((person) => person.id === id)} />
            {canEdit && (
              <button type="button" className="ticket-person-remove" aria-label={t("people.remove", { name: nameOf(id) })} disabled={action.busy} onClick={() => void remove(id)}>×</button>
            )}
          </span>
        ))}
        {canEdit && !adding && <button type="button" className="ticket-dashed" onClick={() => setAdding(true)}>{t("people.add")}</button>}
        {canEdit && adding && (
          <select aria-label={t("people.addLabel")} autoFocus value="" disabled={action.busy} onChange={(event) => void add(event.target.value)}>
            <option value="">{t("people.choose")}</option>
            {candidates.map((person) => <option key={person.id} value={person.id}>{nameWithBadge(person)}</option>)}
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
  const recents = useRecentPlaces();
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
    // O novo pai é um lugar em que a pessoa esteve agora há pouco (TREEPM-358).
    if (parentId !== null) recents.record(detail.projectId, parentId);
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
 * projeto, sem o próprio e sem os que já estão na lista. Esc fecha só o seletor; as setas percorrem busca e lista. Cada ticket diz o
 * tipo da dependência (ADR 0068): "Para começar" ou "Para entregar"; quem pode alterar troca o tipo clicando nele. Adicionar cria
 * "Para começar".
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
  const switchNeed = async (entry: TicketDetail["dependsOn"][number]) => {
    setTried(entry.key);
    const result = await action.run(() => client.addTicketDependency(detail.id, entry.id, otherNeed(entry.need ?? "start")));
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
              {entry.fromLinear === true && <FromLinearBadge />}
            </button>
            {canEdit ? (
              <button
                type="button"
                className="ticket-dep-need"
                aria-label={t("dependsOn.changeNeed", { key: entry.key, need: t(`dependsOn.need.${entry.need ?? "start"}`), other: t(`dependsOn.need.${otherNeed(entry.need ?? "start")}`) })}
                disabled={action.busy}
                onClick={() => void switchNeed(entry)}
              >
                {t(`dependsOn.need.${entry.need ?? "start"}`)}
              </button>
            ) : (
              <span className="ticket-dep-need">{t(`dependsOn.need.${entry.need ?? "start"}`)}</span>
            )}
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

const otherNeed = (need: DependencyNeed): DependencyNeed => (need === "start" ? "deliver" : "start");

/** Tamanho máximo do motivo do impedimento; a API confere o mesmo (ADR 0068). */
const IMPEDIMENT_REASON_MAX = 1000;

/**
 * O impedimento (ADR 0068, seção 5): "Bloqueado" é um problema que alguém marcou, com o motivo. Com impedimento, mostra o motivo, quem
 * marcou e quando, com "Limpar" para quem pode alterar. Sem impedimento, é o campo do motivo (a página só mostra a linha depois de
 * "Marcar impedimento", no menu "Mais ações"); `onDone` fecha a marcação. Esc dentro da edição cancela só a edição.
 */
export function ImpedimentField({ client, detail, canEdit, onDone, onSaved }: FieldBase & { canEdit: boolean; onDone: () => void }) {
  const { t, i18n } = useTranslation("ticket");
  const [reason, setReason] = useState("");
  const action = useAction();
  const impediment = detail.impediment ?? null;
  const cancel = () => {
    setReason("");
    action.clear();
    onDone();
  };
  const save = async () => {
    const text = reason.trim();
    if (text === "") return;
    const result = await action.run(() => client.markTicketImpediment(detail.id, text));
    if (!result.ok) return;
    cancel();
    onSaved();
  };
  const clear = async () => {
    const result = await action.run(() => client.clearTicketImpediment(detail.id));
    if (result.ok) onSaved();
  };
  if (impediment) {
    return (
      <div className="ticket-impediment">
        <p className="ticket-impediment-reason">{impediment.reason}</p>
        <p className="ticket-muted">{t("impediment.by", { name: impediment.by.displayName, date: formatDateTime(i18n.language as Language, impediment.at) })}</p>
        {canEdit && (
          <button type="button" className="text" disabled={action.busy} onClick={() => void clear()}>
            {t("impediment.clear")}
          </button>
        )}
        <ActionError action={action} />
      </div>
    );
  }
  return (
    <div className="ticket-impediment" onKeyDown={cancelOnEscape(cancel)}>
      <textarea aria-label={t("impediment.reasonLabel")} autoFocus maxLength={IMPEDIMENT_REASON_MAX} rows={3} value={reason} onChange={(event) => setReason(event.target.value)} />
      <div className="ticket-impediment-actions">
        <button type="button" disabled={action.busy || reason.trim() === ""} onClick={() => void save()}>
          {t("impediment.save")}
        </button>
        <button type="button" className="text" disabled={action.busy} onClick={cancel}>
          {t("impediment.cancel")}
        </button>
      </div>
      <ActionError action={action} />
    </div>
  );
}

/** Selo discreto das ligações e comentários trazidos do Linear por uma sincronização (ADR 0061). */
export function FromLinearBadge() {
  const { t } = useTranslation("ticket");
  return <span className="ticket-via" title={t("activity.viaLinearTitle")}>{t("activity.viaLinear")}</span>;
}

interface RelatedProps {
  client: ApiClient;
  detail: TicketDetail;
  canEdit: boolean;
  onOpen: (id: string) => void;
  onSaved: () => void;
}

/**
 * "Relacionado a" (ADR 0061, fatia 3): a relação simétrica que vem do Linear. Só se remove aqui; não há como criar pela tela,
 * por isso a linha só existe quando há relações.
 */
export function RelatedField({ client, detail, canEdit, onOpen, onSaved }: RelatedProps) {
  const { t } = useTranslation("ticket");
  const action = useAction();
  const describeError = useDescribeApiError();
  const remove = async (id: string) => {
    const result = await action.run(() => client.removeTicketRelated(detail.id, id));
    if (result.ok) onSaved();
  };
  return (
    <>
      <div className="ticket-deps">
        {detail.related.map((entry) => (
          <span key={entry.id} className="ticket-dep">
            <button type="button" className="ticket-chip ticket-chip-button" onClick={() => onOpen(entry.id)}>
              <StatusMark status={entry.status} />
              <span className="ticket-key">{entry.key}</span>
              <span className="ticket-child-title">{entry.title}</span>
              {entry.fromLinear === true && <FromLinearBadge />}
            </button>
            {canEdit && (
              <button type="button" className="ticket-person-remove" aria-label={t("related.remove", { key: entry.key })} disabled={action.busy} onClick={() => void remove(entry.id)}>×</button>
            )}
          </span>
        ))}
      </div>
      {action.error && <p role="alert" className="ticket-error">{describeError(action.error)}</p>}
    </>
  );
}
