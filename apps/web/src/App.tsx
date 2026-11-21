import { lazy, Suspense } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Demo } from "./demo/Demo.js";
import { Loading } from "./Loading.js";

const AuthenticatedApp = lazy(() => import("./AuthenticatedApp.js"));

export function App() {
  const { t } = useTranslation();
  if (new URLSearchParams(window.location.search).has("demo")) return <Demo />;

  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
  if (!publishableKey) {
    return (
      <main className="entry-screen">
        <h1>{t("config.title")}</h1>
        <p><Trans i18nKey="config.hint" components={{ code: <code /> }} /></p>
        <a href="?demo">{t("config.openDemo")}</a>
      </main>
    );
  }

  return (
    <Suspense fallback={<Loading />}>
      <AuthenticatedApp publishableKey={publishableKey} />
    </Suspense>
  );
}
