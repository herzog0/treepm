import { lazy, Suspense } from "react";
import { Demo } from "./demo/Demo.js";
import { Loading } from "./Loading.js";

const AuthenticatedApp = lazy(() => import("./AuthenticatedApp.js"));

export function App() {
  if (new URLSearchParams(window.location.search).has("demo")) return <Demo />;

  const publishableKey = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY?.trim();
  if (!publishableKey) {
    return (
      <main className="entry-screen">
        <h1>Configuração do TreePM</h1>
        <p>Defina <code>VITE_CLERK_PUBLISHABLE_KEY</code> em <code>apps/web/.env.local</code>.</p>
        <a href="?demo">Abrir a demonstração</a>
      </main>
    );
  }

  return (
    <Suspense fallback={<Loading />}>
      <AuthenticatedApp publishableKey={publishableKey} />
    </Suspense>
  );
}
