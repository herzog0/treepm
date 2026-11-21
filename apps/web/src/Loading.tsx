import { useTranslation } from "react-i18next";

export function Loading() {
  const { t } = useTranslation();
  return (
    <main className="entry-screen">
      <p role="status">{t("loading.app")}</p>
    </main>
  );
}
