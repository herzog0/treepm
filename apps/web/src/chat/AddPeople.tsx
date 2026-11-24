import { useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Person } from "../api/client.js";
import { TestBadge } from "../people/TestBadge.js";

interface AddPeopleProps {
  /** Quem pode entrar: enxerga o ticket (se a thread trata de um) e ainda não está na thread. */
  candidates: readonly Person[];
  status: "loading" | "ready" | "error";
  /** Devolve o texto do erro, ou `null` se deu certo. */
  onAdd: (personIds: string[]) => Promise<string | null>;
}

/** "Incluir pessoas" numa thread que a pessoa abriu: quem entra vê o histórico da thread e das threads dentro dela. */
export function AddPeople({ candidates, status, onAdd }: AddPeopleProps) {
  const { t } = useTranslation("chat");
  const id = useId();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const opener = useRef<HTMLButtonElement>(null);
  const shown = candidates.filter((person) => person.displayName.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const close = () => {
    setOpen(false);
    setQuery("");
    setChosen([]);
    setError(null);
    // O diálogo some: o foco volta ao botão que o abriu.
    opener.current?.focus();
  };
  const submit = async () => {
    setBusy(true);
    setError(null);
    const problem = await onAdd(chosen);
    setBusy(false);
    if (problem === null) close();
    else setError(problem);
  };
  return (
    <div className="chat-add-people">
      <button ref={opener} type="button" className="chat-text-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => (open ? close() : setOpen(true))}>{t("add.open")}</button>
      {open && (
        <div role="dialog" aria-label={t("add.label")} className="chat-picker" onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(); } }}>
          <input type="search" autoFocus aria-label={t("picker.search")} placeholder={t("picker.search")} value={query} onChange={(event) => setQuery(event.target.value)} />
          <p className="chat-levels-note" id={`${id}-warn`}>{t("add.warning")}</p>
          {status === "loading" && <p role="status" className="chat-hint">{t("picker.loading")}</p>}
          {status === "error" && <p role="alert" className="chat-hint">{t("picker.failed")}</p>}
          {status === "ready" && shown.length === 0 && <p className="chat-hint">{t("add.none")}</p>}
          <ul>
            {shown.map((person) => (
              <li key={person.id}>
                <label>
                  <input type="checkbox" checked={chosen.includes(person.id)} onChange={(event) => setChosen((current) => (event.target.checked ? [...current, person.id] : current.filter((other) => other !== person.id)))} />
                  {person.displayName}<TestBadge person={person} />
                </label>
              </li>
            ))}
          </ul>
          {error && <p role="alert" className="chat-composer-alert">{error}</p>}
          <button type="button" className="chat-send is-thread" aria-describedby={`${id}-warn`} disabled={chosen.length === 0 || busy} onClick={() => void submit()}>{t("add.submit")}</button>
        </div>
      )}
    </div>
  );
}
