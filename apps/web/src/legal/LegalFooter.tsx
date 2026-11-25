import { useTranslation } from "react-i18next";
import { LEGAL_DOCUMENTS } from "./documents.js";

/** Rodapé discreto da tela de entrada: leva aos dois documentos públicos. */
export function LegalFooter() {
  const { t } = useTranslation("legal");
  return (
    <nav className="legal-footer" aria-label={t("footer.label")}>
      <a href={LEGAL_DOCUMENTS.terms.path}>{t("documents.terms")}</a>
      <a href={LEGAL_DOCUMENTS.privacy.path}>{t("documents.privacy")}</a>
    </nav>
  );
}
