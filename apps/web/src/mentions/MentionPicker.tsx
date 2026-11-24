import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { TicketSummary } from "../api/client.js";
import { TestBadge } from "../people/TestBadge.js";
import { situationColor } from "../chat/situation.js";
import { ticketStateText } from "../map/ticketState.js";
import type { MenuItem } from "../ticket/description/suggestions.js";
import { MentionList } from "./MentionList.js";
import type { CaretPoint } from "./MentionList.js";

/** Iniciais no lugar da foto: `avatarUrl` é endereço remoto e a plataforma não carrega nada de fora. */
export function Initials({ name }: { name: string }) {
  const letters = name.trim().split(/\s+/).slice(0, 2).map((word) => word.charAt(0).toLocaleUpperCase()).join("");
  return <span className="chat-initials" aria-hidden="true">{letters}</span>;
}

export interface PickerState {
  kind: "ticket" | "person";
  /** O que se digitou depois do `#` ou do `@`. */
  query: string;
  items: readonly MenuItem[];
  selected: number;
  point: CaretPoint | null;
  command: (item: MenuItem) => void;
}

interface MentionPickerProps {
  state: PickerState;
  /** O campo de escrever, onde a lista se prende. */
  box: DOMRect | null;
  idPrefix: string;
  /** Carregando, falhou ou sem resultado: no lugar das opções (o que está faltando é de quem chama). */
  message?: ReactNode;
  /** O caminho do ticket na árvore (a linha de baixo da opção), quando quem chama sabe. */
  pathOf?: (ticket: TicketSummary) => string;
}

export const pickerOptionId = (prefix: string, key: string) => `${prefix}-option-${key}`;

/**
 * O seletor de `#` (tickets) e de `@` (pessoas): o mesmo desenho e o mesmo teclado na descrição, nos comentários e nas conversas.
 * Quem tem o foco é sempre o campo (padrão de caixa de combinação, com `aria-activedescendant`).
 */
export function MentionPicker({ state, box, idPrefix, message, pathOf }: MentionPickerProps) {
  const { t } = useTranslation("chat");
  const { t: tMap } = useTranslation("map");
  const people = state.kind === "person";
  const active = state.items[state.selected];
  const options = state.items.map((item) => {
    const { ticket, person } = item;
    return {
      key: item.id,
      disabled: person?.blocked === true,
      content: ticket ? (
        <>
          <span className="mention-dot" aria-hidden="true" style={{ background: situationColor(ticket) }} />
          <span className="mention-option-text">
            <span className="mention-option-title"><code>{ticket.key}</code> {ticket.title}</span>
            <span className="mention-option-sub">{pathOf ? t("picker.sub", { path: pathOf(ticket), state: ticketStateText(tMap, ticket) }) : ticketStateText(tMap, ticket)}</span>
          </span>
        </>
      ) : (
        <>
          <Initials name={person?.name ?? ""} />
          <span className="mention-option-text">
            <span className="mention-option-title">{person?.name}<TestBadge person={person ? { isTest: person.isTest } : null} /></span>
            {person?.blocked === true && <span className="mention-option-sub">{t("picker.noProject")}</span>}
          </span>
        </>
      ),
    };
  });
  return (
    <MentionList
      label={people ? t("picker.people") : t("picker.tickets")}
      typed={`${people ? "@" : "#"}${state.query}`}
      listId={`${idPrefix}-list`}
      optionId={(key) => pickerOptionId(idPrefix, key)}
      options={options}
      activeKey={active?.id ?? null}
      box={box}
      point={state.point}
      hint={people ? t("picker.hintPeople") : t("picker.hintTickets")}
      message={message ?? (options.length === 0 ? <p className="mention-note">{people ? t("picker.none") : t("picker.noneTickets")}</p> : null)}
      onPick={(key) => {
        const item = state.items.find((entry) => entry.id === key);
        if (item && item.person?.blocked !== true) state.command(item);
      }}
    />
  );
}
