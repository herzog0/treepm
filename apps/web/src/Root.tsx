import { lazy, Suspense } from "react";
import { legalDocumentForPath } from "./legal/documents.js";

// Cada ramo é um pedaço separado: quem só lê um documento não baixa o Clerk, o mapa nem a aplicação.
const LegalPage = lazy(() => import("./legal/LegalPage.js").then((module) => ({ default: module.LegalPage })));
const App = lazy(() => import("./App.js").then((module) => ({ default: module.App })));

export function Root() {
  const document = legalDocumentForPath(window.location.pathname);
  return <Suspense fallback={null}>{document ? <LegalPage document={document} /> : <App />}</Suspense>;
}
