import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { Area, ApiClient, Me, Project } from "../api/client.js";
import { useApiResource } from "../api/useApiResource.js";
import { LoadError } from "../LoadError.js";
import { ConfirmAction } from "./ConfirmAction.js";
import { safe } from "./safe.js";
import { useAction } from "./useAction.js";
import { useDescribeApiError } from "../api/errorText.js";

export interface AreasSectionProps {
  client: ApiClient;
  me: Me;
  selectedProject: Project | null;
  onChanged: () => void;
}

export function AreasSection({ client, me }: AreasSectionProps) {
  const { t } = useTranslation("panel");
  const { state, reload, retry } = useApiResource(() => safe(() => client.listAreas()));
  const isAdmin = me.roles.clerk === "admin";

  return (
    <section aria-labelledby="areas-title">
      <h2 id="areas-title">{t("areas.title")}</h2>
      {isAdmin && <CreateAreaForm client={client} onDone={reload} />}
      {state.status === "loading" && <p role="status">{t("areas.loading")}</p>}
      {state.status === "error" && <LoadError error={state.error} onRetry={retry} />}
      {state.status === "ready" &&
        (state.data.length === 0 ? (
          <p>{t("areas.empty")}</p>
        ) : (
          <ul className="panel-list">
            {state.data.map((area) => (
              <AreaRow key={area.id} area={area} client={client} canEdit={isAdmin} onDone={reload} />
            ))}
          </ul>
        ))}
    </section>
  );
}

function CreateAreaForm({ client, onDone }: { client: ApiClient; onDone: () => void }) {
  const { t } = useTranslation("panel");
  const describeError = useDescribeApiError();
  const [name, setName] = useState("");
  const [missing, setMissing] = useState(false);
  const action = useAction();

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    setMissing(trimmed === "");
    if (trimmed === "") return;
    const result = await action.run(() => client.createArea({ name: trimmed }));
    if (result.ok) {
      setName("");
      onDone();
    }
  };

  return (
    <form className="panel-form" onSubmit={(event) => void submit(event)}>
      <label>
        {t("areas.create.label")}
        <input value={name} onChange={(event) => setName(event.target.value)} />
      </label>
      <button type="submit" className="primary" disabled={action.busy}>
        {t("areas.create.submit")}
      </button>
      {missing && <p role="alert">{t("areas.create.missing")}</p>}
      {action.error && <p role="alert">{describeError(action.error)}</p>}
    </form>
  );
}

function AreaRow({ area, client, canEdit, onDone }: { area: Area; client: ApiClient; canEdit: boolean; onDone: () => void }) {
  const { t } = useTranslation("panel");
  const describeError = useDescribeApiError();
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(area.name);
  const action = useAction();

  const save = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    const result = await action.run(() => client.renameArea(area.id, { name: trimmed }));
    if (result.ok) {
      setEditing(false);
      onDone();
    }
  };

  const remove = async () => {
    const result = await action.run(() => client.removeArea(area.id));
    if (result.ok) onDone();
  };

  const cancelEdit = () => {
    setEditing(false);
    setName(area.name);
    action.clear();
  };

  return (
    <li>
      {editing ? (
        <form className="panel-form inline" onSubmit={(event) => void save(event)}>
          <input aria-label={t("areas.row.renameField", { name: area.name })} value={name} onChange={(event) => setName(event.target.value)} />
          <button type="submit" disabled={action.busy}>
            {t("areas.row.save")}
          </button>
          <button type="button" onClick={cancelEdit}>
            {t("areas.row.cancel")}
          </button>
        </form>
      ) : (
        <div className="row">
          <span>{area.name}</span>
          {canEdit && (
            <span className="row-actions">
              <button type="button" aria-label={t("areas.row.renameLabel", { name: area.name })} onClick={() => setEditing(true)}>
                {t("areas.row.rename")}
              </button>
              <ConfirmAction label={t("areas.row.remove")} accessibleLabel={t("areas.row.removeLabel", { name: area.name })} disabled={action.busy} onConfirm={() => void remove()} />
            </span>
          )}
        </div>
      )}
      {action.error && <p role="alert">{describeError(action.error)}</p>}
    </li>
  );
}
