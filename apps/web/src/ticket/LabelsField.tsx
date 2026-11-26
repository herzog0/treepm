import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { KeyboardEvent, MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { cleanLabelName, defaultLabelColor, labelNameKey } from "@treepm/domain";
import type { ApiClient, ApiError, ChangeTicketLabelsBody, Label, TicketDetail } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { LabelPill } from "../labels/LabelPill.js";
import { cancelOnEscape } from "./fields.js";

const byKey = (a: Label, b: Label) => {
  const [ka, kb] = [labelNameKey(a.name), labelNameKey(b.name)];
  return ka < kb ? -1 : ka > kb ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
};
const sameSet = (a: readonly Label[], b: readonly Label[]) => a.length === b.length && a.every((label, i) => label.id === b[i]?.id && label.name === b[i]?.name && label.color === b[i]?.color);

type Option = { kind: "label"; label: Label; on: boolean } | { kind: "create"; name: string };

/**
 * Campo "Etiquetas" (ADR 0065). Atualização otimista com fila serial: a pastilha entra ou sai no clique (nada anda depois, entre um
 * mousedown e o mouseup seguinte), os pedidos vão um de cada vez e a resposta só substitui a tela quando a fila esvazia (a resposta de
 * um pedido antigo não apaga o que veio depois). Em erro, volta ao último estado confirmado e descarta o resto da fila. Nada grava a
 * cada tecla, nada fica `disabled` e o seletor não remonta enquanto grava.
 *
 * O segundo clique de um duplo clique (`detail > 1`) não faz nada: a lista muda sob o ponteiro depois do primeiro (a vizinha desliza para
 * o lugar da pastilha tirada, outra opção ocupa o lugar de "Criar"), e o segundo atingiria outra etiqueta. Tirar uma etiqueta que outra
 * pessoa apagou (404 `label_not_found`) vale como sucesso: ela já não está.
 */
const secondClick = (event: ReactMouseEvent) => event.detail > 1;
export function LabelsField({ client, detail, canEdit, onSaved }: { client: ApiClient; detail: TicketDetail; canEdit: boolean; onSaved: () => void }) {
  const { t } = useTranslation("ticket");
  const describeError = useDescribeApiError();
  const fromDetail = useMemo(() => [...(detail.labels ?? [])].sort(byKey), [detail.labels]);
  const [labels, setLabels] = useState<Label[]>(fromDetail);
  const [error, setError] = useState<ApiError | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const [project, setProject] = useState<Label[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const confirmed = useRef<Label[]>(fromDetail);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const epoch = useRef(0);
  const current = useRef(labels);
  current.current = labels;
  const wrapper = useRef<HTMLDivElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const removeButtons = useRef(new Map<string, HTMLButtonElement>());
  const focusAfter = useRef<string | "add" | "input" | null>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;

  // O detalhe recarregado (depois de gravar, ou mudança de outra pessoa) vale quando nada desta tela está em voo.
  useEffect(() => {
    if (pending.current > 0) return;
    confirmed.current = fromDetail;
    setLabels((now) => (sameSet(now, fromDetail) ? now : fromDetail));
  }, [fromDetail]);

  const loadProject = useCallback(async () => {
    const result = await client.listProjectLabels(detail.projectId);
    if (result.ok) {
      setProject(result.data.map(({ id, name, color }) => ({ id, name, color })));
      setLoadFailed(false);
    } else setLoadFailed(true);
  }, [client, detail.projectId]);

  const options = useMemo<Option[]>(() => {
    // Sem a lista do projeto ainda, nenhuma opção: a lista não cresce sob o ponteiro quando ela chega.
    if (project === null) return [];
    const onTicket = new Set(labels.map((label) => labelNameKey(label.name)));
    const known = [...(project ?? [])];
    for (const label of labels) if (!known.some((entry) => labelNameKey(entry.name) === labelNameKey(label.name))) known.push(label);
    known.sort(byKey);
    const typed = cleanLabelName(query);
    const key = typed === null ? "" : labelNameKey(typed);
    const list: Option[] = known.filter((label) => labelNameKey(label.name).includes(key)).map((label) => ({ kind: "label", label, on: onTicket.has(labelNameKey(label.name)) }));
    // A mesma chave do banco: não oferece criar o que já existe no projeto (nem o que está no ticket), visível ou não na lista.
    if (typed !== null && !known.some((label) => labelNameKey(label.name) === key)) list.push({ kind: "create", name: typed });
    return list;
  }, [labels, project, query]);

  useEffect(() => setActive((at) => Math.min(at, Math.max(options.length - 1, 0))), [options.length]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${baseId}-opt-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [active, open, baseId]);

  // Clique fora fecha (o foco fica onde a pessoa clicou).
  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (!wrapper.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown, true);
    return () => document.removeEventListener("mousedown", onDown, true);
  }, [open]);

  // O foco nunca cai no <body>: depois de tirar uma pastilha pelo botão dela, vai para a vizinha, ou para "Adicionar".
  useLayoutEffect(() => {
    const target = focusAfter.current;
    if (target === null) return;
    focusAfter.current = null;
    if (target === "input") input.current?.focus();
    else if (target === "add") addButton.current?.focus();
    else (removeButtons.current.get(target) ?? addButton.current)?.focus();
  });

  const change = (body: ChangeTicketLabelsBody, next: Label[]) => {
    setError(null);
    setLabels([...next].sort(byKey));
    const mine = epoch.current;
    pending.current += 1;
    queue.current = queue.current.then(async () => {
      if (mine !== epoch.current) {
        pending.current -= 1;
        return;
      }
      let result: Awaited<ReturnType<ApiClient["changeTicketLabels"]>>;
      try {
        result = await client.changeTicketLabels(detail.id, body);
      } catch {
        result = { ok: false, error: { kind: "unavailable" } };
      }
      pending.current -= 1;
      if (mine !== epoch.current) return;
      if (!result.ok && result.error.code === "label_not_found" && (body.add ?? []).length === 0) {
        // Só tirava, e a etiqueta já não existe (outra pessoa a apagou): o pedido chegou ao estado que queria. Recarrega o ticket (pelo
        // `onSaved`) e a lista do projeto.
        const gone = new Set(body.remove ?? []);
        confirmed.current = confirmed.current.filter((label) => !gone.has(label.id));
        setProject((list) => (list === null ? list : list.filter((label) => !gone.has(label.id))));
        void loadProject();
        if (pending.current === 0) {
          setLabels((now) => (sameSet(now, confirmed.current) ? now : confirmed.current));
          onSaved();
        }
        return;
      }
      if (!result.ok) {
        epoch.current += 1;
        setLabels(confirmed.current);
        setError(result.error);
        if (result.error.code === "label_not_found") void loadProject();
        return;
      }
      confirmed.current = [...result.data.labels].sort(byKey);
      const known = result.data.labels.filter((label) => !label.id.startsWith("pending:"));
      setProject((list) => {
        if (list === null) return list;
        const extra = known.filter((label) => !list.some((entry) => entry.id === label.id));
        return extra.length === 0 ? list : [...list, ...extra].sort(byKey);
      });
      if (pending.current === 0) {
        setLabels((now) => (sameSet(now, confirmed.current) ? now : confirmed.current));
        onSaved();
      }
    });
  };

  const removeLabel = (label: Label) => change({ remove: [label.id] }, current.current.filter((entry) => entry.id !== label.id));
  const addLabel = (label: Label) => change({ add: [{ labelId: label.id }] }, [...current.current, label]);
  const createLabel = (name: string) => change({ add: [{ name }] }, [...current.current, { id: `pending:${labelNameKey(name)}`, name, color: defaultLabelColor(name) }]);

  const choose = (option: Option | undefined) => {
    if (!option) return;
    if (option.kind === "create") {
      createLabel(option.name);
      setQuery("");
      setActive(0);
      return;
    }
    // Um nome criado agora e ainda em voo tem id provisório: escolher de novo antes da resposta não manda nada.
    if (option.label.id.startsWith("pending:")) return;
    if (option.on) removeLabel(current.current.find((label) => labelNameKey(label.name) === labelNameKey(option.label.name)) ?? option.label);
    else addLabel(option.label);
  };

  const openPicker = () => {
    setOpen(true);
    setQuery("");
    setActive(0);
    focusAfter.current = "input";
    void loadProject();
  };
  const closePicker = () => {
    setOpen(false);
    focusAfter.current = "add";
  };

  const onRemoveClick = (label: Label, event: ReactMouseEvent) => {
    if (secondClick(event) || label.id.startsWith("pending:")) return;
    const at = labels.findIndex((entry) => entry.id === label.id);
    const neighbour = labels[at + 1] ?? labels[at - 1];
    focusAfter.current = open ? "input" : neighbour ? labelNameKey(neighbour.name) : "add";
    removeLabel(label);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (options.length === 0) return;
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((at) => (at + step + options.length) % options.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(options[active]);
    } else if (event.key === "Backspace" && query === "" && !event.repeat) {
      // Só um toque novo tira a última: segurar Backspace para apagar o texto não continua tirando etiquetas.
      const last = current.current.at(-1);
      if (last && !last.id.startsWith("pending:")) {
        event.preventDefault();
        removeLabel(last);
      }
    }
  };
  // Esc com o seletor aberto fecha o seletor onde quer que esteja o foco na linha (busca, "Adicionar", um "×"), e não a página.
  const onFieldKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (open) cancelOnEscape(closePicker)(event);
  };

  const status = project === null ? (loadFailed ? t("labels.loadFailed") : t("labels.loading")) : options.length === 0 ? (project.length === 0 ? t("labels.empty") : t("labels.noMatch")) : null;

  return (
    <div className="ticket-labels" ref={wrapper} onKeyDown={onFieldKeyDown}>
      <div className="ticket-labels-row">
        {labels.length === 0 && !canEdit ? <span className="ticket-value ticket-labels-none">{t("labels.none")}</span> : null}
        {labels.map((label) => (
          <LabelPill
            key={labelNameKey(label.name)}
            label={label}
            remove={
              canEdit ? (
                <button
                  type="button"
                  className="label-pill-remove"
                  aria-label={t("labels.remove", { name: label.name })}
                  aria-disabled={label.id.startsWith("pending:") || undefined}
                  ref={(node) => {
                    if (node) removeButtons.current.set(labelNameKey(label.name), node);
                    else removeButtons.current.delete(labelNameKey(label.name));
                  }}
                  onClick={(event) => onRemoveClick(label, event)}
                >
                  <span aria-hidden="true">×</span>
                </button>
              ) : undefined
            }
          />
        ))}
        {canEdit ? (
          <button
            type="button"
            ref={addButton}
            className="ticket-labels-add"
            aria-label={t("labels.addLabel")}
            aria-expanded={open}
            aria-haspopup="listbox"
            onClick={() => (open ? closePicker() : openPicker())}
          >
            {t("labels.add")}
          </button>
        ) : null}
      </div>
      {open ? (
        <div className="ticket-labels-picker">
          <input
            ref={input}
            className="ticket-labels-search"
            role="combobox"
            aria-label={t("labels.search")}
            placeholder={t("labels.search")}
            aria-expanded="true"
            aria-controls={listId}
            aria-autocomplete="list"
            aria-activedescendant={options.length > 0 ? `${baseId}-opt-${active}` : undefined}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
            onKeyDown={onKeyDown}
            onBlur={(event) => {
              if (!wrapper.current?.contains(event.relatedTarget as Node | null) && event.relatedTarget !== null) setOpen(false);
            }}
          />
          <ul id={listId} role="listbox" aria-label={t("labels.list")} aria-multiselectable="true" className="ticket-labels-options">
            {options.map((option, i) => (
              <li
                key={option.kind === "create" ? "create" : labelNameKey(option.label.name)}
                id={`${baseId}-opt-${i}`}
                role="option"
                aria-selected={option.kind === "label" ? option.on : false}
                className={`ticket-labels-option${i === active ? " is-active" : ""}`}
                onMouseDown={(event) => event.preventDefault()}
                onMouseMove={() => setActive(i)}
                onClick={(event) => {
                  if (!secondClick(event)) choose(option);
                }}
              >
                {option.kind === "label" ? (
                  <>
                    <span className="ticket-labels-check" aria-hidden="true" />
                    <LabelPill label={option.label} />
                  </>
                ) : (
                  <>
                    <span className="ticket-labels-check is-create" aria-hidden="true" />
                    <span className="ticket-labels-create">{t("labels.create", { name: option.name })}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
          {status ? <p className="ticket-labels-status">{status}</p> : null}
          {/* Com o seletor aberto, o erro vai dentro dele, depois da lista: fora, ficaria atrás do seletor. */}
          {error ? <p role="alert" className="ticket-error">{describeError(error)}</p> : null}
        </div>
      ) : null}
      {error && !open ? <p role="alert" className="ticket-error">{describeError(error)}</p> : null}
    </div>
  );
}
