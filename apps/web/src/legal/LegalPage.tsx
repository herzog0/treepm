import { useEffect, useMemo } from "react";
import { useTranslation } from "react-i18next";
import "../i18n/index.js";
import "./legal.css";
import { otherDocument } from "./documents.js";
import type { LegalDocument } from "./documents.js";
import { LEGAL_MARKDOWN } from "./content.js";
import { renderLegalMarkdown } from "./render.js";

/** Página pública de leitura: sem sessão, sem Clerk e sem a aplicação autenticada. */
export function LegalPage({ document: legal }: { document: LegalDocument }) {
  const { t, i18n } = useTranslation("legal");
  const html = useMemo(() => renderLegalMarkdown(LEGAL_MARKDOWN[legal.id]), [legal]);
  const other = otherDocument(legal.id);
  const name = t(`documents.${legal.id}`);

  useEffect(() => {
    document.title = t("tabTitle", { document: name, brand: t("brand") });
  }, [t, name, i18n.language]);

  return (
    <div className="legal-page">
      <header className="legal-header">
        <a className="legal-brand" href="/">{t("brand")}</a>
        <nav aria-label={t("footer.label")}>
          <a href={other.path}>{t(`documents.${other.id}`)}</a>
        </nav>
      </header>
      <main className="legal-main">
        {i18n.language !== "pt-BR" && <p className="legal-notice" role="note">{t("portugueseOnly")}</p>}
        <article className="legal-document" lang="pt-BR" dangerouslySetInnerHTML={{ __html: html }} />
      </main>
    </div>
  );
}
