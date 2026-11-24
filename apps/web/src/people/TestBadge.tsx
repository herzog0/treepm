import { useTranslation } from "react-i18next";

/** O selo "teste" das pessoas de teste (ADR 0057), junto do nome onde pessoas são listadas ou escolhidas. */
export function TestBadge({ person }: { person: { isTest?: boolean | undefined } | null | undefined }) {
  const { t } = useTranslation("app");
  return person?.isTest === true ? <span className="test-badge">{t("testBadge")}</span> : null;
}

/** Para onde só cabe texto (uma opção de `<select>`): "Bia (teste)". */
export function useNameWithBadge(): (person: { displayName: string; isTest?: boolean | undefined }) => string {
  const { t } = useTranslation("app");
  return (person) => (person.isTest === true ? t("testName", { name: person.displayName }) : person.displayName);
}
