import { LABEL_COLORS, cleanLabelName } from "@treepm/domain";
import { useEffect, useRef, useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, LabelColorKey, Project, ProjectLabel } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useApiResource } from "../api/useApiResource.js";
import { LabelDot, LabelPill } from "../labels/LabelPill.js";
import { LoadError } from "../LoadError.js";
import { safe } from "./safe.js";
import { useAction } from "./useAction.js";

interface LabelsSectionProps {
  client: ApiClient;
  project: Project;
  /** Quem administra o projeto renomeia, troca a cor e apaga; os demais só veem a lista (ADR 0065). Projeto arquivado: só a lista. */
  canManage: boolean;
}

/**
 * Etiquetas do projeto nas configurações (ADR 0065): a pastilha, quantos tickets usam cada uma e, para quem administra,
 * renomear em linha, trocar a cor e apagar com confirmação. Etiqueta se cria na página do ticket, não aqui.
 */
export function LabelsSection({ client, project, canManage }: LabelsSectionProps) {
  const { t } = useTranslation("panel");
  const { state, reload, retry } = useApiResource(() => safe(() => client.listProjectLabels(project.id)));
  const heading = useRef<HTMLHeadingElement>(null);
  // Projeto arquivado é somente leitura (a API recusa com 409 `project_archived`): nada de renomear, trocar cor nem apagar.
  const manage = canManage && project.archivedAt === null;

  // Depois de apagar, a linha some: o foco vai para o título da seção em vez de cair no body.
  const removed = () => {
    heading.current?.focus();
    reload();
  };

  return (
    <section aria-labelledby="project-labels-title" className="panel-labels">
      <h3 id="project-labels-title" ref={heading} tabIndex={-1}>
        {t("detail.labels.title")}
      </h3>
      {state.status === "loading" && <p role="status">{t("detail.labels.loading")}</p>}
      {state.status === "error" && <LoadError error={state.error} onRetry={retry} />}
      {state.status === "ready" &&
        (state.data.length === 0 ? (
          <p>{t("detail.labels.empty")}</p>
        ) : (
          <ul className="panel-list" aria-label={t("detail.labels.list")}>
            {state.data.map((label) => (
              <LabelRow key={label.id} client={client} projectId={project.id} label={label} canManage={manage} onSaved={reload} onRemoved={removed} />
            ))}
          </ul>
        ))}
    </section>
  );
}

function LabelRow({
  client,
  projectId,
  label,
  canManage,
  onSaved,
  onRemoved,
}: {
  client: ApiClient;
  projectId: string;
  label: ProjectLabel;
  canManage: boolean;
  onSaved: () => void;
  onRemoved: () => void;
}) {
  const { t } = useTranslation("panel");
  const { t: tTicket } = useTranslation("ticket");
  const describeError = useDescribeApiError();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(label.name);
  // Cor escolhida enquanto a gravação não volta: o botão fica pressionado na hora.
  const [pendingColor, setPendingColor] = useState<LabelColorKey | null>(null);
  const action = useAction();
  // Guarda contra o segundo envio: o botão fica `aria-disabled` (não `disabled`), para o foco não cair no body.
  const sending = useRef(false);
  // Apagada com sucesso: a linha some quando a lista recarregar; até lá, nada mais nela manda pedido.
  const removedRef = useRef(false);
  const renameButton = useRef<HTMLButtonElement>(null);
  const [focusRename, setFocusRename] = useState(false);

  useEffect(() => {
    if (!editing && focusRename) {
      renameButton.current?.focus();
      setFocusRename(false);
    }
  }, [editing, focusRename]);

  useEffect(() => setPendingColor(null), [label.color]);

  const run = async (call: () => Promise<{ ok: boolean }>): Promise<boolean> => {
    if (sending.current) return false;
    sending.current = true;
    try {
      const result = await call();
      return result.ok;
    } finally {
      sending.current = false;
    }
  };

  const save = async (event: FormEvent) => {
    event.preventDefault();
    // Sem mudança (o nome limpo é o que já está): não grava, para não desfazer em silêncio a renomeação de outra pessoa.
    if (cleanLabelName(name) === label.name) {
      closeEdit();
      return;
    }
    const ok = await run(() => action.run(() => client.updateProjectLabel(projectId, label.id, { name })));
    if (ok) {
      closeEdit();
      onSaved();
    }
  };

  // O campo abre com o nome ATUAL da etiqueta (a lista pode ter recarregado com uma renomeação de outra pessoa).
  const startEdit = () => {
    setName(label.name);
    setEditing(true);
  };

  const closeEdit = () => {
    setEditing(false);
    setFocusRename(true);
  };

  const cancel = () => {
    if (sending.current) return;
    setName(label.name);
    action.clear();
    closeEdit();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    cancel();
  };

  const changeColor = async (color: LabelColorKey) => {
    if (sending.current || color === (pendingColor ?? label.color)) return;
    setPendingColor(color);
    const ok = await run(() => action.run(() => client.updateProjectLabel(projectId, label.id, { color })));
    if (ok) onSaved();
    else setPendingColor(null);
  };

  // Confirmação própria em vez do `ConfirmAction`: o botão Confirmar fica montado (e `aria-disabled`) enquanto apaga, para o foco não cair no body.
  const [confirming, setConfirming] = useState(false);
  const confirmButton = useRef<HTMLButtonElement>(null);
  const removeButton = useRef<HTMLButtonElement>(null);
  const [focusRemove, setFocusRemove] = useState(false);
  useEffect(() => {
    if (confirming) confirmButton.current?.focus();
    else if (focusRemove) {
      removeButton.current?.focus();
      setFocusRemove(false);
    }
  }, [confirming, focusRemove]);

  const cancelRemove = () => {
    if (sending.current) return;
    setConfirming(false);
    setFocusRemove(true);
  };

  const remove = async () => {
    if (removedRef.current) return;
    const ok = await run(() => action.run(() => client.removeProjectLabel(projectId, label.id)));
    if (ok) {
      removedRef.current = true;
      onRemoved();
    }
  };

  // "Essa etiqueta não existe mais. A lista foi atualizada.": quem viu o erro recebe a lista de novo.
  useEffect(() => {
    if (action.error?.code === "label_not_found") onSaved();
  }, [action.error, onSaved]);

  const color = pendingColor ?? label.color;
  const removeLabel = t("detail.labels.removeLabel", { name: label.name });
  const count = label.ticketCount === 0 ? t("detail.labels.countNone") : t("detail.labels.count", { count: label.ticketCount });
  const message =
    label.ticketCount === 0
      ? t("detail.labels.removeMessageUnused", { name: label.name })
      : t("detail.labels.removeMessage", { name: label.name, count: label.ticketCount });

  return (
    <li className="panel-label-row">
      {editing ? (
        <form className="panel-form inline" onSubmit={(event) => void save(event)}>
          <input
            aria-label={t("detail.labels.renameField", { name: label.name })}
            value={name}
            autoFocus
            onChange={(event) => setName(event.target.value)}
            onKeyDown={onKeyDown}
          />
          <button type="submit" aria-disabled={action.busy || undefined}>
            {t("detail.labels.save")}
          </button>
          <button type="button" onClick={cancel}>
            {t("detail.labels.cancel")}
          </button>
        </form>
      ) : (
        <div className="row">
          <LabelPill label={{ name: label.name, color }} />
          <span className="panel-label-count">{count}</span>
          {canManage && (
            <span className="row-actions">
              <button ref={renameButton} type="button" aria-label={t("detail.labels.renameLabel", { name: label.name })} onClick={startEdit}>
                {t("detail.labels.rename")}
              </button>
              {confirming ? (
                <span className="confirm-action">
                  <span className="confirm-message">{message}</span>
                  <button
                    ref={confirmButton}
                    type="button"
                    className="danger"
                    aria-label={t("confirm.label", { subject: removeLabel })}
                    aria-disabled={action.busy || removedRef.current || undefined}
                    onClick={() => void remove()}
                  >
                    {t("confirm.confirm")}
                  </button>
                  <button type="button" onClick={cancelRemove}>
                    {t("confirm.cancel")}
                  </button>
                </span>
              ) : (
                <button ref={removeButton} type="button" className="destructive" aria-label={removeLabel} onClick={() => setConfirming(true)}>
                  {t("detail.labels.remove")}
                </button>
              )}
            </span>
          )}
        </div>
      )}
      {canManage && !editing && (
        <ColorPicker
          name={t("detail.labels.colors", { name: label.name })}
          color={color}
          busy={action.busy}
          colorName={(key) => tTicket(`labels.colors.${key}`)}
          onPick={(key) => void changeColor(key)}
        />
      )}
      {action.error && <p role="alert">{describeError(action.error)}</p>}
    </li>
  );
}

/**
 * Seletor de cor da etiqueta: oito botões com `aria-pressed` num grupo. As setas só movem o foco (tabindex itinerante);
 * Enter, Espaço ou clique gravam. Rádios gravariam a cada seta, e nada grava a cada tecla.
 */
function ColorPicker({
  name,
  color,
  busy,
  colorName,
  onPick,
}: {
  name: string;
  color: LabelColorKey;
  busy: boolean;
  colorName: (key: LabelColorKey) => string;
  onPick: (key: LabelColorKey) => void;
}) {
  const current = Math.max(0, LABEL_COLORS.indexOf(color));
  const [active, setActive] = useState(current);
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);

  // A cor gravada (ou escolhida) passa a ser a parada do Tab.
  useEffect(() => setActive(current), [current]);

  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const next = (index + step + LABEL_COLORS.length) % LABEL_COLORS.length;
    setActive(next);
    buttons.current[next]?.focus();
  };

  return (
    <div className="panel-label-colors" role="group" aria-label={name}>
      {LABEL_COLORS.map((key, index) => (
        <button
          key={key}
          ref={(element) => {
            buttons.current[index] = element;
          }}
          type="button"
          className="panel-label-color"
          aria-label={colorName(key)}
          title={colorName(key)}
          aria-pressed={color === key}
          aria-disabled={busy || undefined}
          tabIndex={index === active ? 0 : -1}
          onFocus={() => setActive(index)}
          onKeyDown={(event) => onKeyDown(event, index)}
          onClick={() => {
            if (!busy) onPick(key);
          }}
        >
          <LabelDot color={key} />
        </button>
      ))}
    </div>
  );
}
