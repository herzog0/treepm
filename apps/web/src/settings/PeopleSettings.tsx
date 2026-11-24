import { useState } from "react";
import type { FormEvent } from "react";
import { useTranslation } from "react-i18next";
import type { ApiClient, Me, Person } from "../api/client.js";
import { useDescribeApiError } from "../api/errorText.js";
import { useApiResource } from "../api/useApiResource.js";
import { safe } from "../panel/safe.js";
import { useAction } from "../panel/useAction.js";
import { useActAs } from "../people/ActAs.js";
import { TestBadge } from "../people/TestBadge.js";
import { initials } from "../ticket/fields.js";
import { SettingsCard, SettingsLoadError, SettingsLoading, SettingsNote, SettingsRow } from "./parts.js";
import "./people-settings.css";

/** Quantas pessoas de teste ativas cabem em uma organização (o mesmo limite do servidor, ADR 0057). */
export const TEST_PEOPLE_LIMIT = 20;
const MAX_NAME = 80;

/** A seção "Pessoas" só existe para administrador que não está agindo como outra pessoa (ADR 0057). */
export const peopleAvailable = ({ me, isAdmin }: { me: Me | null | undefined; isAdmin: boolean }): boolean => isAdmin && me != null && (me.actingAs ?? null) === null;

/**
 * Conteúdo da seção "Pessoas" das Configurações (ADR 0057): quem faz parte da organização e as pessoas de teste, com "Entrar como" e
 * "Desativar" só nelas. O título e a frase da seção são da casca.
 */
export function PeopleSettings({ client, me, titleId }: { client: ApiClient; me: Me; titleId: string }) {
  const { t } = useTranslation("settings");
  const describeError = useDescribeApiError();
  const { enter } = useActAs();
  const { state, reload, retry } = useApiResource(() => safe(() => client.listPeople()));
  const action = useAction();
  const [name, setName] = useState("");

  const run = async (change: () => ReturnType<ApiClient["createTestPerson"]>): Promise<boolean> => {
    const result = await action.run(change);
    if (result.ok) reload();
    return result.ok;
  };
  const create = async (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === "") return;
    if (await run(() => client.createTestPerson(trimmed))) setName("");
  };

  if (state.status === "loading") return <SettingsLoading>{t("people.loading")}</SettingsLoading>;
  if (state.status === "error") return <SettingsLoadError error={state.error} onRetry={retry} />;

  const real = state.data.filter((person) => person.isTest !== true);
  const test = state.data.filter((person) => person.isTest === true);
  const activeTest = test.filter((person) => person.active).length;

  const title = (person: Person, showRole: boolean) => (
    <>
      <span className="people-avatar" aria-hidden="true">{initials(person.displayName)}</span>
      {person.displayName}
      <TestBadge person={person} />
      {showRole && person.clerkRole === "admin" && <span className="people-tag">{t("people.admin")}</span>}
      {!person.active && <span className="people-tag is-off">{t("people.inactive")}</span>}
    </>
  );
  const hint = (person: Person, isTestRow: boolean) =>
    [person.id === me.person.id ? t("people.you") : isTestRow ? null : person.email, t(person.clerkRole === "admin" ? "people.roleAdmin" : "people.roleMember")].filter(Boolean).join(" · ");

  return (
    <>
      <SettingsCard title={t("people.organization")} titleId={`${titleId}-org`} note={t("people.count", { count: real.length })}>
        <ul className="people-list" aria-labelledby={`${titleId}-org`}>
          {real.map((person) => (
            <li key={person.id}><SettingsRow title={title(person, true)} hint={hint(person, false)} /></li>
          ))}
        </ul>
      </SettingsCard>
      <SettingsCard title={t("people.testPeople")} titleId={`${titleId}-test`} note={t("people.testCount", { count: activeTest, limit: TEST_PEOPLE_LIMIT })}>
        <ul className="people-list" aria-labelledby={`${titleId}-test`}>
          {test.map((person) => (
            <li key={person.id}>
              <SettingsRow
                title={title(person, false)}
                hint={hint(person, true)}
                control={
                  <span className="people-actions">
                    {person.active && (
                      <button type="button" className="primary" disabled={action.busy} aria-label={t("people.enterLabel", { name: person.displayName })} onClick={() => enter({ id: person.id, displayName: person.displayName })}>
                        {t("people.enter")}
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={action.busy}
                      aria-label={t(person.active ? "people.deactivateLabel" : "people.reactivateLabel", { name: person.displayName })}
                      onClick={() => void run(() => (person.active ? client.deactivateTestPerson(person.id) : client.reactivateTestPerson(person.id)))}
                    >
                      {t(person.active ? "people.deactivate" : "people.reactivate")}
                    </button>
                  </span>
                }
              />
            </li>
          ))}
        </ul>
        <form className="people-create" onSubmit={(event) => void create(event)}>
          <input type="text" aria-label={t("people.nameLabel")} placeholder={t("people.namePlaceholder")} maxLength={MAX_NAME} value={name} onChange={(event) => setName(event.target.value)} />
          <button type="submit" disabled={action.busy || name.trim() === "" || activeTest >= TEST_PEOPLE_LIMIT}>{t("people.create")}</button>
        </form>
      </SettingsCard>
      {action.error && <SettingsNote role="alert" tone="error">{describeError(action.error)}</SettingsNote>}
    </>
  );
}
