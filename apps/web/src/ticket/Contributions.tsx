import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, Contribution, ContributionStatus, Person, TicketDetail, TicketSummary } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useApiResource } from "../api/useApiResource.js";
import { viewHref } from "../nav/navigation.js";
import { ConfirmAction } from "../panel/ConfirmAction.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { RichDescription } from "./description/RichDescription.js";
import { initials } from "./fields.js";
import { ActionsMenu, OptionMenu } from "./menu.js";

const STATUSES: readonly ContributionStatus[] = ["todo", "in_progress", "done"];

type Action = ReturnType<typeof useAction>;
const ActionError = ({ action }: { action: Action }) => {
  const describeError = useDescribeApiError();
  return action.error ? <p role="alert" className="ticket-error">{describeError(action.error)}</p> : null;
};

export interface ContributionsProps {
  client: ApiClient;
  detail: TicketDetail;
  people: readonly Person[];
  tickets: readonly TicketSummary[];
  /** Administrador da organização: quem pode cadastrar áreas. */
  isAdmin: boolean;
  onOpenTicket: (id: string) => void;
  /** Depois de qualquer alteração: a página recarrega o ticket e a atividade. */
  onSaved: () => void;
}

/** Seção "Áreas" (ADR 0041): uma contribuição por área, com situação, pessoas e texto. Só lê quem não pode editar. */
export function Contributions({ client, detail, people, tickets, isAdmin, onOpenTicket, onSaved }: ContributionsProps) {
  const { t } = useTranslation("ticket");
  const canEdit = detail.canEditContributions === true;
  const contributions = detail.contributions ?? [];
  const areas = useApiResource(() => (canEdit ? safe(() => client.listAreas()) : Promise.resolve({ ok: true as const, data: [] })));
  const adding = useAction();
  if (!canEdit && contributions.length === 0) return null;

  const used = new Set(contributions.map((entry) => entry.area.id));
  const free = areas.state.status === "ready" ? areas.state.data.filter((area) => !used.has(area.id)) : [];
  const none = areas.state.status === "ready" && areas.state.data.length === 0;
  const add = async (areaId: string) => {
    const result = await adding.run(() => client.createContribution(detail.id, { areaId }));
    if (result.ok) onSaved();
  };

  return (
    <section className="ticket-section" aria-labelledby="ticket-areas-heading">
      <div className="ticket-section-head">
        <h2 id="ticket-areas-heading">{t("contributions.heading")}</h2>
        {canEdit && free.length > 0 && (
          <span className="ticket-section-actions">
            <OptionMenu
              label={t("contributions.heading")}
              trigger={<>{t("contributions.add")}</>}
              options={free.map((area) => ({ value: area.id, label: area.name }))}
              value=""
              disabled={adding.busy}
              onChoose={(areaId) => void add(areaId)}
            />
          </span>
        )}
      </div>
      {none && canEdit && (
        <p className="ticket-muted">
          {t("contributions.noAreas")}
          {isAdmin && (
            <>
              {" "}
              <a href={viewHref("settings")}>{t("contributions.manageAreas")}</a>
            </>
          )}
        </p>
      )}
      <ActionError action={adding} />
      <div className="ticket-contributions">
        {contributions.map((contribution) => (
          <ContributionBlock key={contribution.id} client={client} detail={detail} contribution={contribution} people={people} tickets={tickets} canEdit={canEdit} onOpenTicket={onOpenTicket} onSaved={onSaved} />
        ))}
      </div>
    </section>
  );
}

interface BlockProps {
  client: ApiClient;
  detail: TicketDetail;
  contribution: Contribution;
  people: readonly Person[];
  tickets: readonly TicketSummary[];
  canEdit: boolean;
  onOpenTicket: (id: string) => void;
  onSaved: () => void;
}

function ContributionBlock({ client, detail, contribution, people, tickets, canEdit, onOpenTicket, onSaved }: BlockProps) {
  const { t } = useTranslation("ticket");
  const action = useAction();
  const [addingPerson, setAddingPerson] = useState(false);
  const name = contribution.area.name;
  const statusLabel = (status: ContributionStatus) => t(`contributions.status.${status}`);
  const inContribution = new Set(contribution.people.map((person) => person.id));
  const candidates = people.filter((person) => person.active && !inContribution.has(person.id));

  const changeStatus = async (status: ContributionStatus) => {
    const result = await action.run(() => client.updateContribution(contribution.id, { status }));
    if (result.ok) onSaved();
  };
  const addPerson = async (personId: string) => {
    if (personId === "") return;
    const result = await action.run(() => client.putContributionPerson(contribution.id, personId));
    if (!result.ok) return;
    setAddingPerson(false);
    onSaved();
  };
  const removePerson = async (personId: string) => {
    const result = await action.run(() => client.removeContributionPerson(contribution.id, personId));
    if (result.ok) onSaved();
  };
  const remove = async () => {
    const result = await action.run(() => client.removeContribution(contribution.id));
    if (result.ok) onSaved();
  };

  return (
    <div role="group" aria-label={name} className="ticket-contribution">
      <div className="ticket-contribution-head">
        <h3>{name}</h3>
        {canEdit ? (
          <OptionMenu
            label={t("contributions.statusGroup")}
            trigger={<>{statusLabel(contribution.status)}</>}
            options={STATUSES.map((status) => ({ value: status, label: statusLabel(status) }))}
            value={contribution.status}
            disabled={action.busy}
            onChoose={(status) => void changeStatus(status)}
          />
        ) : (
          <span className="ticket-value">{statusLabel(contribution.status)}</span>
        )}
        {canEdit && (
          <ActionsMenu label={t("contributions.more", { area: name })} trigger={<span aria-hidden="true">…</span>}>
            {(close) => (
              <ConfirmAction
                label={t("contributions.remove")}
                message={t("contributions.removeWarning")}
                disabled={action.busy}
                onConfirm={() => {
                  close();
                  void remove();
                }}
              />
            )}
          </ActionsMenu>
        )}
      </div>
      <div className="ticket-people">
        {contribution.people.length === 0 && !canEdit && <span className="ticket-muted">{t("people.nobody")}</span>}
        {contribution.people.map((person) => (
          <span key={person.id} className="ticket-person">
            <span aria-hidden="true" className="ticket-avatar">{initials(person.displayName)}</span>
            {person.displayName}
            {canEdit && (
              <button type="button" className="ticket-person-remove" aria-label={t("contributions.removePerson", { name: person.displayName, area: name })} disabled={action.busy} onClick={() => void removePerson(person.id)}>×</button>
            )}
          </span>
        ))}
        {canEdit && !addingPerson && <button type="button" className="ticket-dashed" aria-label={t("contributions.addPersonLabel", { area: name })} onClick={() => setAddingPerson(true)}>{t("people.add")}</button>}
        {canEdit && addingPerson && (
          <select aria-label={t("contributions.addPersonLabel", { area: name })} autoFocus value="" disabled={action.busy} onChange={(event) => void addPerson(event.target.value)}>
            <option value="">{t("people.choose")}</option>
            {candidates.map((person) => <option key={person.id} value={person.id}>{person.displayName}</option>)}
          </select>
        )}
      </div>
      <ContributionText client={client} detail={detail} contribution={contribution} tickets={tickets} canEdit={canEdit} onOpenTicket={onOpenTicket} onSaved={onSaved} />
      <ActionError action={action} />
    </div>
  );
}

type SaveState = "idle" | "saving" | "saved";

/** O texto da área: o mesmo componente da descrição (sem "Pedir ao assistente"), salvando sozinho ao sair do campo. */
function ContributionText({ client, detail, contribution, tickets, canEdit, onOpenTicket, onSaved }: Omit<BlockProps, "people">) {
  const { t } = useTranslation("ticket");
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(contribution.text);
  const [state, setState] = useState<SaveState>("idle");
  const [saved, setSaved] = useState<{ from: string; text: string } | null>(null);
  const [revision, setRevision] = useState(0);
  const action = useAction();
  const busy = useRef(false);
  const value = saved && saved.from === contribution.text ? saved.text : contribution.text;
  const name = contribution.area.name;

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
    const result = await action.run(() => client.updateContribution(contribution.id, { text }));
    busy.current = false;
    if (!result.ok) {
      setState("idle");
      return false;
    }
    setSaved({ from: contribution.text, text });
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
  const toggleTask = async (text: string) => {
    if (!(await commit(text))) setRevision((current) => current + 1);
  };
  const openMention = async (id: string) => {
    if (editing && !(await commit(draft))) return;
    onOpenTicket(id);
  };

  const empty = value.trim() === "";
  return (
    <div className="ticket-contribution-text">
      <span aria-live="polite" aria-atomic="true" className="description-head-state">{state === "saving" ? t("description.saving") : state === "saved" ? t("description.saved") : ""}</span>
      {empty && !editing ? (
        canEdit ? <button type="button" className="description-invite" onClick={startEditing}>{t("contributions.placeholder")}</button> : null
      ) : (
        <RichDescription
          key={revision}
          value={value}
          editing={editing}
          canEdit={canEdit}
          label={t("contributions.textLabel", { area: name })}
          placeholder={t("contributions.placeholder")}
          mentions={{ projectId: detail.projectId, tickets, ownId: detail.id }}
          onChange={setDraft}
          autoFocus
          onRequestEdit={startEditing}
          onLeave={() => void leave()}
          onSubmit={() => void leave()}
          onCancel={cancel}
          onToggleTask={(text) => void toggleTask(text)}
          onOpenMention={(id) => void openMention(id)}
        />
      )}
      <ActionError action={action} />
    </div>
  );
}
